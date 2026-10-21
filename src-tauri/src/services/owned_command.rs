//! Captured CLI processes remain owned until their output and exit are known.
//! Dropping a timed-out/cancelled future terminates its entire private tree.
use std::{
    io,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};

struct OwnedChild {
    child: Child,
    #[cfg(unix)]
    group: Option<libc::pid_t>,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(group) = self.group {
            // The leader is deliberately not reaped before both pipes close,
            // so its PID/PGID cannot be recycled while this guard owns it.
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        // Windows closes the kill-on-close job below, including grandchildren.
        // kill_on_drop reaps the direct child through Tokio on cancellation.
    }
}

#[cfg(windows)]
pub(crate) fn process_job(child: &Child) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::*;
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // Own the handle immediately: any failure closes the configured job.
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let process = child
        .raw_handle()
        .ok_or_else(|| io::Error::other("CLI exited before job assignment"))?;
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// Gateway's first preload blocks on stdin. The injectable assignment seam
/// lets native tests prove failure paths never release engine code.
#[cfg(windows)]
pub(crate) async fn gate_gateway_child(
    child: &mut Child,
    assign: impl FnOnce(&Child) -> io::Result<std::os::windows::io::OwnedHandle>,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use tokio::io::AsyncWriteExt;
    let job = match assign(child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    let ack = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing private startup pipe"))?;
        stdin.write_all(&[0xa7]).await?;
        stdin.shutdown().await?;
        Ok::<_, io::Error>(())
    };
    if !matches!(
        tokio::time::timeout(Duration::from_secs(2), ack).await,
        Ok(Ok(()))
    ) {
        terminate_job(&job, child).await?;
        return Err(io::Error::other("private startup ACK failed"));
    }
    Ok(job)
}

/// Terminate only this held job, then prove all members exited. A failed
/// query or timeout leaves recovery blocked; a leader exit alone is insufficient.
#[cfg(windows)]
pub(crate) async fn terminate_job(
    job: &std::os::windows::io::OwnedHandle,
    child: &mut Child,
) -> io::Result<()> {
    request_job_termination(job)?;
    confirm_job_termination(job, child).await
}

#[cfg(windows)]
pub(crate) fn request_job_termination(job: &std::os::windows::io::OwnedHandle) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) async fn confirm_job_termination(
    job: &std::os::windows::io::OwnedHandle,
    child: &mut Child,
) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::*;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if info.ActiveProcesses == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        child.wait().await?;
        Ok(())
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "owned job termination unconfirmed"))?
}

#[cfg(unix)]
fn exit_observed(pid: u32) -> io::Result<bool> {
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
        return Ok(false);
    }
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(unix)]
async fn observe_exit(pid: u32) -> io::Result<()> {
    loop {
        if exit_observed(pid)? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub async fn output(mut command: Command, budget: Duration) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let job = match process_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    #[cfg(unix)]
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Missing CLI process id"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing stderr"))?;
    let mut owned = OwnedChild {
        child,
        #[cfg(unix)]
        group: Some(pid as libc::pid_t),
        #[cfg(windows)]
        _job: job,
    };
    let capture = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        #[cfg(unix)]
        {
            tokio::try_join!(
                stdout.read_to_end(&mut out),
                stderr.read_to_end(&mut err),
                observe_exit(pid)
            )?;
            // Kill any remaining descendants before reaping the pinned leader.
            unsafe {
                libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
        let status = owned.child.wait().await?;
        #[cfg(unix)]
        {
            owned.group = None;
        }
        Ok::<_, io::Error>(Output {
            status,
            stdout: out,
            stderr: err,
        })
    };
    tokio::time::timeout(budget, capture).await.map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "CLI exceeded its execution budget; process tree terminated",
        )
    })?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn captures_output_and_nonzero_exit() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf captured; printf failure >&2; exit 7"]);
        let out = output(cmd, Duration::from_secs(3)).await.unwrap();
        assert_eq!(out.status.code(), Some(7));
        assert_eq!(out.stdout, b"captured");
        assert_eq!(out.stderr, b"failure");
    }
    #[tokio::test]
    async fn timeout_and_cancellation_stop_descendant_writes() {
        for cancel in [false, true] {
            let file = std::env::temp_dir().join(format!("uniopc-owned-{}", uuid::Uuid::new_v4()));
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "(sleep 1; printf orphan > \"$1\") & wait", "sh"]);
            cmd.arg(&file);
            let task = tokio::spawn(output(cmd, Duration::from_millis(150)));
            if cancel {
                tokio::time::sleep(Duration::from_millis(100)).await;
                task.abort();
                let _ = task.await;
            } else {
                assert_eq!(
                    task.await.unwrap().unwrap_err().kind(),
                    io::ErrorKind::TimedOut
                );
            }
            tokio::time::sleep(Duration::from_millis(1100)).await;
            assert!(
                !file.exists(),
                "cancelled descendant wrote after command ended"
            );
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    const FIXTURE: &str = "services::owned_command::windows_tests::descendant_fixture";

    // A real grandchild waits for a signal before attempting its side effect.
    // A timeout test must kill it, not merely return before it becomes ready.
    #[test]
    fn descendant_fixture() {
        let Ok(path) = std::env::var("UNIOPC_OWNED_COMMAND_FIXTURE") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        if std::env::var("UNIOPC_OWNED_COMMAND_LEAF").is_ok() {
            std::fs::write(path.with_extension("ready"), std::process::id().to_string()).unwrap();
            for _ in 0..3000 {
                if path.with_extension("go").exists() {
                    std::fs::write(&path, "orphan").unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        } else {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", FIXTURE, "--nocapture"])
                .env("UNIOPC_OWNED_COMMAND_LEAF", "1")
                .spawn()
                .unwrap()
                .wait()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn job_terminates_real_grandchildren_on_timeout_and_cancellation() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        for cancel in [false, true] {
            let file = std::env::temp_dir().join(format!("uniopc-job-{}", uuid::Uuid::new_v4()));
            let mut cmd = Command::new(std::env::current_exe().unwrap());
            cmd.args(["--exact", FIXTURE, "--nocapture"])
                .env("UNIOPC_OWNED_COMMAND_FIXTURE", &file);
            let task = tokio::spawn(output(cmd, Duration::from_secs(10)));
            for _ in 0..400 {
                if file.with_extension("ready").exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let leaf_pid = std::fs::read_to_string(file.with_extension("ready"))
                .expect("grandchild must have started before cancellation")
                .parse::<u32>()
                .unwrap();
            if cancel {
                task.abort();
                let _ = task.await;
            } else {
                assert_eq!(
                    task.await.unwrap().unwrap_err().kind(),
                    io::ErrorKind::TimedOut
                );
            }
            std::fs::write(file.with_extension("go"), "go").unwrap();
            let mut alive = true;
            for _ in 0..100 {
                let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, leaf_pid) };
                if handle.is_null() {
                    alive = false;
                    break;
                }
                let mut code = 0;
                let queried = unsafe { GetExitCodeProcess(handle, &mut code) };
                unsafe {
                    CloseHandle(handle);
                }
                if queried != 0 && code != 259 {
                    alive = false;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(!alive, "job left a live grandchild after cancellation");
            assert!(
                !file.exists(),
                "cancelled grandchild produced a side effect"
            );
            let _ = std::fs::remove_file(file.with_extension("ready"));
            let _ = std::fs::remove_file(file.with_extension("go"));
        }
    }
}
