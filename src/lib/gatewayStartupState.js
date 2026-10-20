export function gatewayStartupState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      ready: false,
      keepPolling: false,
      message: null,
      error: 'Gateway 启动命令未返回状态，请重试。',
    }
  }

  if (snapshot.status === 'connected') {
    return {
      ready: true,
      keepPolling: false,
      message: 'Gateway 已启动，马上进入 Uniopc。',
    }
  }

  return {
    ready: false,
    keepPolling: true,
    message: 'Gateway 子进程已启动，正在等待连接稳定。',
  }
}
