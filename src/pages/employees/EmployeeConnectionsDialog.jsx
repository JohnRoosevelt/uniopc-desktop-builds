import EmployeeAvatar from '../../components/EmployeeAvatar'
import Modal from '../../components/Modal'
import { ACTION, SURFACE } from '../../lib/theme'

function formatEmployeeDocKind(kind) {
  if (kind === 'profile') return '身份与规则'
  if (kind === 'memory') return '记忆'
  return '工作区'
}

export default function EmployeeConnectionsDialog({
  employee,
  open,
  onClose,
  feishuAccount,
  wechatAccount,
  selectedChannelKind,
  onChannelKindChange,
  feishuOverview,
  feishuForm,
  onFeishuAccountChange,
  onFeishuFormChange,
  savingFeishu,
  loadingFeishu,
  bindingFeishu,
  onSaveFeishu,
  onUnbindFeishu,
  wechatOverview,
  configuredWechatAccounts,
  wechatForm,
  onWechatAccountChange,
  wechatQrSession,
  loadingWechat,
  installingWechat,
  bindingWechat,
  startingWechatQr,
  checkingWechatQr,
  onInstallWechat,
  onRefreshWechatQr,
  onCheckWechatQr,
  onRefreshWechat,
  onBindWechat,
  onUnbindWechat,
  onOpenExternalUrl,
  documentsOpen,
  onCloseDocuments,
  documentsEmployee,
  documents,
  loadingDocuments,
  selectedDocumentPath,
  onSelectDocument,
  documentDetail,
  loadingDocument,
  editingDocument,
  documentValue,
  onDocumentValueChange,
  renderedDocument,
  isDocumentDirty,
  savingDocument,
  onStartDocumentEditing,
  onCancelDocumentEditing,
  onSaveDocument,
}) {
  return (
    <>
      <Modal
        open={documentsOpen}
        onClose={onCloseDocuments}
        size="3xl"
        title={documentsEmployee ? `${documentsEmployee.name} · 员工文档` : '员工文档'}
        description="这里管理的是当前 AI员工自己的 workspace 文档，不会和项目共享文档混在一起。"
        bodyClassName="pt-4"
      >
        <div className="grid min-h-[72vh] gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="rounded-3xl border border-subtle bg-surface-sunken p-3">
            <div className="mb-3 px-2">
              <div className="text-xs uppercase tracking-[0.16em] text-tertiary">Agent Workspace</div>
              <div className="mt-2 text-base font-semibold text-primary">{documentsEmployee?.name || '员工文档'}</div>
              <div className="mt-1 text-sm text-secondary">身份、规则、工具约定和长期记忆都归属于这个员工自己。</div>
            </div>

            <div className="min-h-[440px] space-y-1 overflow-y-auto">
              {loadingDocuments ? (
                <div className="rounded-2xl border border-subtle bg-surface-raised px-4 py-4 text-sm text-secondary">
                  正在读取员工 workspace 文档...
                </div>
              ) : documents.length === 0 ? (
                <div className="rounded-2xl border border-subtle bg-surface-raised px-4 py-4 text-sm leading-6 text-secondary">
                  这个员工还没有文档。系统通常会自动补齐 `IDENTITY.md`、`AGENTS.md`、`SOUL.md`、`USER.md`、`TOOLS.md`、`MEMORY.md`。
                </div>
              ) : (
                documents.map(doc => {
                  const active = selectedDocumentPath === doc.relative_path
                  return (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => onSelectDocument(doc.relative_path)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition-colors ${
                        active
                          ? 'border-violet-400/28 bg-violet-400/12'
                          : 'border-subtle bg-surface-raised hover:bg-state-hover'
                      }`}
                    >
                      <div className="truncate text-sm font-medium text-primary">{doc.title}</div>
                      <div className="mt-1 truncate text-xs text-tertiary">{doc.relative_path}</div>
                      <div className="mt-2 inline-flex rounded-full border border-subtle bg-surface-raised px-2 py-0.5 text-2xs text-secondary">
                        {formatEmployeeDocKind(doc.kind)}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          <section className="rounded-3xl border border-subtle bg-surface-sunken">
            {!selectedDocumentPath ? (
              <div className="flex h-full min-h-[440px] items-center justify-center px-10 text-center">
                <div>
                  <div className="text-lg font-semibold text-primary">先选择一篇员工文档</div>
                  <div className="mt-2 text-sm leading-6 text-secondary">左侧会展示这个 AI员工自己的身份、规则和记忆文件。</div>
                </div>
              </div>
            ) : loadingDocument ? (
              <div className="flex h-full min-h-[440px] items-center justify-center px-10 text-center">
                <div>
                  <div className="text-lg font-semibold text-primary">正在读取员工文档</div>
                  <div className="mt-2 text-sm leading-6 text-secondary">正在从当前 agent workspace 加载 Markdown 文件。</div>
                </div>
              </div>
            ) : documentDetail ? (
              <div className="flex h-full flex-col">
                <div className="border-b border-subtle px-6 py-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs uppercase tracking-[0.16em] text-tertiary">{formatEmployeeDocKind(documentDetail.kind)}</div>
                      <h3 className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-primary">{documentDetail.title}</h3>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
                        <span>{documentDetail.relative_path}</span>
                        <span>·</span>
                        <span>{documentDetail.updated_at}</span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {editingDocument ? (
                        <>
                          <button type="button" onClick={onCancelDocumentEditing} className={ACTION.secondary} disabled={savingDocument}>
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={onSaveDocument}
                            className={ACTION.primary}
                            disabled={!isDocumentDirty || savingDocument}
                          >
                            {savingDocument ? '保存中...' : '保存'}
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={onStartDocumentEditing} className={ACTION.primary}>编辑</button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
                  {editingDocument ? (
                    <div className="space-y-3">
                      <textarea
                        value={documentValue}
                        onChange={event => onDocumentValueChange(event.target.value)}
                        className="h-[calc(100vh-28rem)] min-h-[480px] w-full resize-none rounded-2xl border border-subtle bg-surface-raised px-6 py-5 text-base leading-8 text-primary outline-none transition-colors placeholder:text-tertiary focus:border-violet-400/25"
                        placeholder="编辑这个 AI员工自己的 Markdown 文档。"
                      />
                      <p className="text-xs text-tertiary">这里保存的是这个员工 workspace 里的真实 Markdown 文件。</p>
                    </div>
                  ) : (
                    <article
                      className="min-h-[480px] text-lg leading-8 text-primary [&_h1:first-child]:mt-0 [&_p:first-child]:mt-0"
                      dangerouslySetInnerHTML={{ __html: renderedDocument }}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full min-h-[440px] items-center justify-center px-10 text-center">
                <div>
                  <div className="text-lg font-semibold text-primary">文档不存在</div>
                  <div className="mt-2 text-sm leading-6 text-secondary">这篇员工文档可能刚被移动，或者当前项目上下文已经切换。</div>
                </div>
              </div>
            )}
          </section>
        </div>
      </Modal>

      <Modal
        open={open}
        onClose={onClose}
        size="2xl"
        title="连接远程渠道"
        description="给这位员工开通飞书、微信这样的远程接待能力。员工资料和渠道连接是两件事，所以这里单独处理。"
        bodyClassName="pt-4"
      >
        <div className="rounded-3xl border border-subtle bg-surface-sunken p-4">
          <div className="flex items-center gap-3">
            <EmployeeAvatar kind="ai" name={employee.name} emoji={employee.emoji} size="lg" />
            <div>
              <div className="text-base font-semibold text-primary">{employee.name}</div>
              <div className="text-sm text-secondary">{employee.role}</div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {feishuAccount && (
                <span className="rounded-full border border-violet-400/24 bg-violet-400/12 px-2.5 py-1 text-xs text-accent-text">
                  Feishu · {feishuAccount.accountId}
                </span>
              )}
              {wechatAccount && (
                <span className="rounded-full border border-emerald-400/24 bg-emerald-400/12 px-2.5 py-1 text-xs text-success-text">
                  微信 · {wechatAccount.accountId}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-3xl border border-subtle bg-surface-sunken p-4">
          <div className="text-sm leading-7 text-secondary">
            先选择一个渠道，再配置对应连接。Uniopc 引擎 负责实际收发、路由和会话，Uniopc 这里只负责把渠道绑定到当前 AI 员工。
          </div>

          <label className="mt-4 block">
            <div className="mb-2 text-sm font-medium text-secondary">渠道类型</div>
            <select value={selectedChannelKind} onChange={event => onChannelKindChange(event.target.value)} className={SURFACE.select}>
              <option value="feishu">飞书 / Lark</option>
              <option value="wechat">微信个人号</option>
            </select>
            <div className="mt-2 text-xs leading-6 text-tertiary">
              企业微信 / WeCom 还没有独立渠道实现；当前微信入口是个人微信插件。
            </div>
          </label>

          <div className="mt-5 space-y-5">
            {selectedChannelKind === 'feishu' && (
              <section className="rounded-2xl border border-violet-400/14 bg-violet-400/8 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-primary">飞书</div>
                    <div className="mt-1 text-sm leading-6 text-secondary">选择已有账号，或现场补全 App ID / Secret 后直接绑定给当前员工。</div>
                  </div>
                  <div className="rounded-full border border-violet-400/24 bg-violet-400/12 px-2.5 py-1 text-xs text-accent-text">
                    {feishuAccount ? `已绑定 ${feishuAccount.accountId}` : '未绑定'}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-violet-400/14 bg-surface-sunken p-4">
                  <div className="text-sm font-medium text-primary">先准备这两样</div>
                  <div className="mt-2 text-sm leading-7 text-secondary">
                    1. 在飞书开放平台创建企业自建应用，拿到 <span className="text-primary">App ID</span> 和 <span className="text-primary">App Secret</span>
                    <br />
                    2. 按 Uniopc 引擎 的 Feishu 渠道说明完成机器人能力配置
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <button type="button" onClick={() => onOpenExternalUrl('https://open.feishu.cn/')} className={ACTION.secondary}>打开飞书开放平台</button>
                    <button type="button" onClick={() => onOpenExternalUrl('https://docs.openclaw.ai/channels/feishu')} className={ACTION.secondary}>查看 Uniopc 引擎 Feishu 文档</button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-secondary">连接名称</div>
                    <select value={feishuForm.accountId} onChange={event => onFeishuAccountChange(event.target.value)} className={SURFACE.select}>
                      <option value="default">default</option>
                      {(feishuOverview?.accounts || []).map(account => (
                        <option key={account.accountId} value={account.accountId}>
                          {account.accountId}{account.currentAgentId && account.currentAgentId !== employee.id ? ' · 已绑定其他员工' : ''}
                        </option>
                      ))}
                    </select>
                    <div className="mt-2 text-xs leading-6 text-tertiary">
                      通常保持 <span className="text-secondary">default</span> 就可以。只有你要在同一台工作台里配置多个飞书机器人时，才需要换一个连接名称。
                    </div>
                  </label>

                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-secondary">渠道</div>
                    <div className="flex h-[46px] items-center rounded-2xl border border-default bg-surface-sunken px-3.5 text-sm text-primary">飞书</div>
                    <div className="mt-2 text-xs leading-6 text-tertiary">国际租户也可以继续走同一套入口，必要时把 domain 改成 `lark`。</div>
                  </label>

                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-secondary">App ID</div>
                    <input value={feishuForm.appId} onChange={event => onFeishuFormChange({ appId: event.target.value })} placeholder="cli_xxx" className={SURFACE.input} />
                  </label>

                  <label className="block">
                    <div className="mb-2 text-sm font-medium text-secondary">App Secret</div>
                    <input type="password" value={feishuForm.appSecret} onChange={event => onFeishuFormChange({ appSecret: event.target.value })} placeholder="留空则保留现有 secret" className={SURFACE.input} />
                  </label>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={onSaveFeishu} disabled={savingFeishu || loadingFeishu} className={ACTION.primary}>
                    {savingFeishu ? '处理中...' : '保存并绑定 Feishu'}
                  </button>
                  <button type="button" onClick={onUnbindFeishu} disabled={!feishuAccount || bindingFeishu} className={ACTION.secondary}>
                    {bindingFeishu ? '处理中...' : '关闭 Feishu'}
                  </button>
                  <span className="text-xs text-tertiary">{loadingFeishu ? '正在读取 Feishu 连接...' : 'Uniopc 引擎 继续负责真正的渠道收发与路由。'}</span>
                </div>
              </section>
            )}

            {selectedChannelKind === 'wechat' && (
              <section className="rounded-2xl border border-emerald-400/14 bg-emerald-400/8 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-primary">微信</div>
                    <div className="mt-1 text-sm leading-6 text-secondary">
                      微信通过 Uniopc 的微信连接组件接入。组件安装好后，Uniopc 会直接在这里展示二维码，你扫完码再把这条连接绑定给当前员工。
                    </div>
                  </div>
                  <div className="rounded-full border border-emerald-400/24 bg-emerald-400/12 px-2.5 py-1 text-xs text-success-text">
                    {wechatAccount ? `已绑定连接 ${wechatAccount.accountId}` : '未绑定'}
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-emerald-400/14 bg-surface-sunken p-4">
                  <div className="text-sm font-medium text-primary">当前状态</div>
                  <div className="mt-2 text-sm leading-7 text-secondary">
                    {loadingWechat
                      ? '正在读取微信渠道状态...'
                      : !wechatOverview
                        ? '暂时没拿到微信渠道状态。这不等于未安装，你可以点“刷新微信状态”重试。'
                        : !wechatOverview.pluginInstalled
                          ? '当前机器还没有安装微信渠道插件。先安装插件，然后直接在这个弹窗里展示官方返回的微信二维码。'
                          : startingWechatQr && !wechatQrSession?.qrDataUrl
                            ? '正在准备微信二维码。稍等一下，下面会直接出现“扫描连接”的二维码。'
                            : wechatQrSession?.connected
                              ? '微信扫码已经成功，下面会出现这条连接。你现在可以直接绑定到当前员工。'
                              : wechatQrSession?.qrDataUrl
                                ? '请直接扫描下方二维码连接微信，并在手机上确认登录。'
                                : configuredWechatAccounts.length > 0
                                  ? '已检测到可用的微信连接。你可以直接绑定；同时也可以扫描下方二维码新增连接。'
                                  : '插件已安装，正在为你直接准备微信二维码。'}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    {!loadingWechat && wechatOverview && !wechatOverview.pluginInstalled && (
                      <button type="button" onClick={onInstallWechat} disabled={installingWechat} className={ACTION.primary}>
                        {installingWechat ? '安装中...' : '安装微信渠道插件'}
                      </button>
                    )}
                    {wechatOverview?.pluginInstalled && (
                      <button type="button" onClick={onRefreshWechatQr} disabled={startingWechatQr || installingWechat || checkingWechatQr} className={ACTION.secondary}>
                        {startingWechatQr ? '正在刷新二维码...' : wechatQrSession?.qrDataUrl ? '刷新二维码' : '重新获取二维码'}
                      </button>
                    )}
                    <button type="button" onClick={onCheckWechatQr} disabled={!wechatQrSession?.qrDataUrl || checkingWechatQr || startingWechatQr} className={ACTION.secondary}>
                      {checkingWechatQr ? '检查中...' : '我已扫码，检查状态'}
                    </button>
                    <button type="button" onClick={onRefreshWechat} disabled={loadingWechat || installingWechat || bindingWechat || startingWechatQr || checkingWechatQr} className={ACTION.secondary}>
                      刷新微信状态
                    </button>
                    <button type="button" onClick={() => onOpenExternalUrl('https://docs.openclaw.ai/channels/wechat')} className={ACTION.secondary}>
                      查看 Uniopc 引擎 微信文档
                    </button>
                  </div>
                  {wechatQrSession?.message && (
                    <div className="mt-3 rounded-2xl border border-subtle bg-surface-sunken px-3.5 py-3 text-xs leading-6 text-secondary">{wechatQrSession.message}</div>
                  )}
                </div>

                {wechatOverview?.pluginInstalled && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                    <div className="rounded-2xl border border-default bg-surface-sunken p-4">
                      <div className="text-sm font-medium text-primary">扫描连接</div>
                      <div className="mt-3 overflow-hidden rounded-2xl border border-default bg-white p-3">
                        {wechatQrSession?.qrDataUrl ? (
                          <img src={wechatQrSession.qrDataUrl} alt="微信扫码二维码" className="mx-auto block h-auto w-full max-w-[180px] rounded-xl" />
                        ) : configuredWechatAccounts.length ? (
                          <div className="mx-auto flex h-[180px] w-full max-w-[180px] flex-col items-center justify-center rounded-xl bg-stone-100 px-4 text-center">
                            <div className="text-base font-semibold text-stone-700">已有可用连接</div>
                            <div className="mt-2 text-sm leading-6 text-tertiary">可直接在右侧选择并绑定当前员工</div>
                          </div>
                        ) : startingWechatQr ? (
                          <div className="mx-auto flex h-[180px] w-full max-w-[180px] items-center justify-center rounded-xl bg-stone-100 px-4 text-center text-sm leading-6 text-tertiary">正在准备二维码...</div>
                        ) : (
                          <div className="mx-auto flex h-[180px] w-full max-w-[180px] flex-col items-center justify-center rounded-xl bg-stone-100 px-4 text-center">
                            <div className="text-base font-semibold text-stone-700">暂时无法获取二维码</div>
                            <div className="mt-2 text-sm leading-6 text-tertiary">可以先看下方原因说明</div>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 text-xs leading-6 text-secondary">
                        {wechatQrSession?.qrDataUrl
                          ? '直接用微信扫描这里的二维码连接，手机确认后会自动同步到当前页面。'
                          : configuredWechatAccounts.length
                            ? '当前已经检测到可用微信连接，你可以直接在右侧选择后绑定；如果想新增连接，再点上面的“刷新二维码”。'
                            : wechatQrSession?.message || '如果这里一直没有二维码，点上面的“刷新二维码”再试一次。'}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-default bg-surface-sunken p-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        {configuredWechatAccounts.length ? (
                          <label className="block">
                            <div className="mb-2 text-sm font-medium text-secondary">已登录连接</div>
                            <select value={wechatForm.accountId} onChange={event => onWechatAccountChange(event.target.value)} className={SURFACE.select}>
                              {configuredWechatAccounts.map(account => (
                                <option key={account.accountId} value={account.accountId}>
                                  {account.accountId}{account.currentAgentId && account.currentAgentId !== employee.id ? ' · 已绑定其他员工' : ''}
                                </option>
                              ))}
                            </select>
                            <div className="mt-2 text-xs leading-6 text-tertiary">这里显示的是已经扫码成功的微信连接名，不需要额外填写 App ID / Secret。</div>
                          </label>
                        ) : (
                          <label className="block">
                            <div className="mb-2 text-sm font-medium text-secondary">连接名</div>
                            <input value={wechatForm.accountId} onChange={event => onWechatAccountChange(event.target.value)} placeholder="default" className={SURFACE.input} />
                            <div className="mt-2 text-xs leading-6 text-tertiary">这是这条微信连接在 Uniopc 引擎 里的名字，不是你的微信号。默认用 `default` 就可以。</div>
                          </label>
                        )}

                        <div className="block">
                          <div className="mb-2 text-sm font-medium text-secondary">插件状态</div>
                          <div className="flex h-[46px] items-center rounded-2xl border border-default bg-surface-sunken px-3.5 text-sm text-primary">
                            {loadingWechat
                              ? '读取中...'
                              : !wechatOverview
                                ? '读取失败'
                                : !wechatOverview.pluginInstalled
                                  ? '未安装'
                                  : wechatOverview.pluginEnabled
                                    ? `已启用 · ${wechatOverview.pluginStatus || 'loaded'}`
                                    : `已安装 · ${wechatOverview.pluginStatus || 'disabled'}`}
                          </div>
                          <div className="mt-2 text-xs leading-6 text-tertiary">当前二维码和登录状态都通过 Uniopc 引擎 网关获取；如果这里报错，先去运行中心确认 Uniopc 引擎 正常运行。</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={onBindWechat} disabled={bindingWechat || loadingWechat || !configuredWechatAccounts.length || !wechatForm.accountId} className={ACTION.primary}>
                    {bindingWechat ? '处理中...' : '绑定微信账号'}
                  </button>
                  <button type="button" onClick={onUnbindWechat} disabled={!wechatAccount || bindingWechat} className={ACTION.secondary}>
                    {bindingWechat ? '处理中...' : '解绑微信'}
                  </button>
                  <span className="text-xs text-tertiary">微信连接在 Uniopc 引擎 插件里维护，Uniopc 这里负责员工绑定关系。</span>
                </div>
              </section>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}
