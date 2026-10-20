export function callLocalDocument(action: any, payload?: {}, { env, runtimeContext, fetchImpl, signal, }?: {
    env?: NodeJS.ProcessEnv | undefined;
    runtimeContext?: {} | undefined;
    fetchImpl?: typeof fetch | undefined;
}): Promise<any>;
