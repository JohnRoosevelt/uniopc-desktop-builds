declare const TOOL_NAMES: {
    readonly list: "uniopc_local_documents_list";
    readonly get: "uniopc_local_document_get";
    readonly create: "uniopc_local_document_create";
    readonly update: "uniopc_local_document_update";
};
type LocalDocumentAction = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
type LocalDocumentCaller = (action: LocalDocumentAction, payload: Record<string, unknown>, options: {
    runtimeContext: object;
    signal?: AbortSignal;
}) => Promise<unknown>;
export declare function createLocalWorkspaceEntry({ callLocalDocument, }?: {
    callLocalDocument?: LocalDocumentCaller;
}): {
    id: string;
    name: string;
    description: string;
    configSchema: {
        safeParse(value: unknown): {
            success: true;
            data: undefined;
            error?: undefined;
        } | {
            success: false;
            error: {
                issues: {
                    path: never[];
                    message: string;
                }[];
            };
            data?: undefined;
        } | {
            success: true;
            data: object;
            error?: undefined;
        };
        jsonSchema: {
            type: "object";
            additionalProperties: boolean;
            properties: {};
        };
    };
    register(api: {
        registerTool: (tool: unknown, options: {
            name: string;
            optional?: boolean;
        }) => void;
    }): void;
};
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: {
        safeParse(value: unknown): {
            success: true;
            data: undefined;
            error?: undefined;
        } | {
            success: false;
            error: {
                issues: {
                    path: never[];
                    message: string;
                }[];
            };
            data?: undefined;
        } | {
            success: true;
            data: object;
            error?: undefined;
        };
        jsonSchema: {
            type: "object";
            additionalProperties: boolean;
            properties: {};
        };
    };
    register(api: {
        registerTool: (tool: unknown, options: {
            name: string;
            optional?: boolean;
        }) => void;
    }): void;
};
export default _default;
