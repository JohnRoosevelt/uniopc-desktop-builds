import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeCommandQuery,
  buildMentionContext,
  buildMentionResourceOptions,
  buildToolInvocationContext,
  enrichConversationMentions,
  inferDocumentTitleMentions,
  commandToken,
  extractConversationMentions,
  extractConversationToolInvocations,
  filterPluginMentionOptionsByProfile,
  filterMentionOptions,
  insertCommandToken,
  insertMentionToken,
  mentionResourcesLoadingAfterCoreResult,
  mergeMentionResources,
  nearestVisibleMentionIndex,
  selectAgentVisibleSkills,
  slashInvocationKey,
  shouldRefreshSlashMentionResources,
} from './conversationMentions.js'

test('extractConversationMentions ignores callable capability tokens', () => {
  assert.deepEqual(
    extractConversationMentions('用 @plugin:xhs-insights-openclaw-plugin 和 @mcp:tikhub-xiaohongshu 和 @skill:browser-automation 看一下 @mcp:tikhub-xiaohongshu'),
    [],
  )
})

test('extractConversationMentions supports personal Document context references', () => {
  assert.deepEqual(
    extractConversationMentions('结合 @project:project-1 和 @doc:doc-2 写计划'),
    [
      { kind: 'doc', name: 'doc-2' },
    ],
  )
})

test('extractConversationToolInvocations keeps slash commands limited to callable capabilities', () => {
  assert.deepEqual(
    extractConversationToolInvocations('看 @project:project-1 但不要把 /project:project-1 当工具'),
    [],
  )
})

test('extractConversationMentions finds document mentions after punctuation', () => {
  assert.deepEqual(
    extractConversationMentions('(@project:x) and ：@doc:y'),
    [
      { kind: 'doc', name: 'y' },
    ],
  )
})

test('insertMentionToken shows the selected document title while preserving its id for authorization', () => {
  const input = '帮我 @tik'
  const options = [{ kind: 'doc', name: 'doc-1', label: '农村包围城市：AI 十八路打法' }]
  const displayInput = insertMentionToken(input, input.length, options[0])

  assert.equal(
    displayInput,
    '帮我 @doc:《农村包围城市：AI 十八路打法》 ',
  )
  assert.deepEqual(
    enrichConversationMentions(extractConversationMentions(displayInput), options),
    [{ kind: 'doc', name: 'doc-1', label: '农村包围城市：AI 十八路打法', summary: '' }],
  )
})

test('extractConversationToolInvocations returns unique slash command tokens', () => {
  assert.deepEqual(
    extractConversationToolInvocations('用 /plugin:uniopc-cloud-workspace 创建文档，再 /mcp:telegram 通知一下 /plugin:uniopc-cloud-workspace'),
    [
      {
        kind: 'plugin',
        name: 'uniopc-cloud-workspace',
        pluginId: 'uniopc-cloud-workspace',
        toolName: null,
      },
      { kind: 'mcp', name: 'telegram' },
    ],
  )
})

test('extractConversationToolInvocations supports plugin-level and tool-level plugin commands', () => {
  assert.deepEqual(
    extractConversationToolInvocations('先 /plugin:uniopc-cloud-workspace 再 /plugin:uniopc-cloud-workspace.imai_cloud_document_create'),
    [
      {
        kind: 'plugin',
        name: 'uniopc-cloud-workspace',
        pluginId: 'uniopc-cloud-workspace',
        toolName: null,
      },
      {
        kind: 'plugin',
        name: 'uniopc-cloud-workspace.imai_cloud_document_create',
        pluginId: 'uniopc-cloud-workspace',
        toolName: 'imai_cloud_document_create',
      },
    ],
  )
})

test('opening slash commands refreshes stale plugin capabilities once per open', () => {
  assert.equal(shouldRefreshSlashMentionResources({
    trigger: 'slash',
    profile: 'sales-owner-46f19d68b66f',
    employeeId: 'employee-1',
    refreshedKey: '',
  }), true)
  assert.equal(shouldRefreshSlashMentionResources({
    trigger: 'slash',
    profile: 'sales-owner-46f19d68b66f',
    employeeId: 'employee-1',
    refreshedKey: 'sales-owner-46f19d68b66f:employee-1',
  }), false)
  assert.equal(shouldRefreshSlashMentionResources({
    trigger: 'mention',
    profile: 'sales-owner-46f19d68b66f',
    employeeId: 'employee-1',
    refreshedKey: '',
  }), false)
})

test('commandToken and slashInvocationKey preserve selected plugin tools', () => {
  assert.equal(
    commandToken({
      kind: 'plugin',
      pluginId: 'uniopc-cloud-workspace',
      toolName: 'imai_cloud_document_create',
    }),
    '/plugin:uniopc-cloud-workspace.imai_cloud_document_create',
  )
  assert.equal(
    slashInvocationKey({
      kind: 'plugin',
      pluginId: 'uniopc-cloud-workspace',
      toolName: 'imai_cloud_document_create',
    }),
    'plugin:uniopc-cloud-workspace:imai_cloud_document_create',
  )
  assert.equal(
    slashInvocationKey({
      kind: 'plugin',
      name: 'uniopc-cloud-workspace.imai_cloud_document_create',
    }),
    'plugin:uniopc-cloud-workspace:imai_cloud_document_create',
  )
})

test('activeCommandQuery and insertCommandToken replace active slash query', () => {
  const input = '帮我 /imai'
  assert.deepEqual(activeCommandQuery(input, input.length), {
    query: 'imai',
    start: 3,
    end: input.length,
  })
  assert.equal(
    insertCommandToken(input, input.length, { kind: 'plugin', name: 'uniopc-cloud-workspace' }),
    '帮我 /plugin:uniopc-cloud-workspace ',
  )
})

test('activeCommandQuery includes explicit kind prefix in slash query', () => {
  const input = '帮我 /plugin:uni'
  assert.deepEqual(activeCommandQuery(input, input.length), {
    query: 'plugin:uni',
    start: 3,
    end: input.length,
  })
})

test('filterMentionOptions groups options by kind and matches query', () => {
  const options = filterMentionOptions('', [
    { kind: 'doc', name: 'doc-1' },
    { kind: 'skill', name: 'browser-automation' },
    { kind: 'plugin', name: 'xhs-insights-openclaw-plugin' },
    { kind: 'mcp', name: 'tikhub-tiktok' },
    { kind: 'mcp', name: 'context7' },
  ])

  assert.deepEqual(options.map(item => item.name), [
    'xhs-insights-openclaw-plugin',
    'context7',
    'tikhub-tiktok',
    'browser-automation',
    'doc-1',
  ])
})

test('filterMentionOptions matches explicit slash command kind prefixes', () => {
  const options = filterMentionOptions('plugin:uni', [
    { kind: 'plugin', name: 'uniopc-cloud-workspace' },
    { kind: 'mcp', name: 'uniopc-cloud-workspace' },
  ])
  assert.deepEqual(options.map(item => item.kind), ['plugin'])
})

test('visibleMentionOptions keeps every ready slash capability instead of truncating after eight', async () => {
  const { visibleMentionOptions } = await import('./conversationMentions.js')
  const options = Array.from({ length: 11 }, (_, index) => ({
    kind: 'plugin',
    name: `plugin-${String(index + 1).padStart(2, '0')}`,
  }))

  assert.deepEqual(
    visibleMentionOptions('', options).map(option => option.name),
    [
      'plugin-01', 'plugin-02', 'plugin-03', 'plugin-04', 'plugin-05', 'plugin-06',
      'plugin-07', 'plugin-08', 'plugin-09', 'plugin-10', 'plugin-11',
    ],
  )
})

test('buildMentionResourceOptions exposes personal documents outside slash command mode', () => {
  const resources = {
    plugins: [],
    mcps: [],
    skills: [],
    toolPlugins: [{ id: 'uniopc-cloud-workspace', title: 'Workspace', status: 'ready', tools: [{ name: 'uniopc_cloud_documents_list' }] }],
    documents: [{ id: 'doc-1', title: '投放复盘' }],
  }

  assert.deepEqual(
    buildMentionResourceOptions(resources, { commandMode: false }).map(item => [item.kind, item.name, item.label]),
    [
      ['doc', 'doc-1', '投放复盘'],
    ],
  )
  assert.deepEqual(
    buildMentionResourceOptions(resources, { commandMode: true }).map(item => item.kind),
    ['plugin'],
  )
})

test('buildMentionResourceOptions exposes all ready Uniopc plugins in slash command mode', () => {
  const options = buildMentionResourceOptions({
    toolPlugins: [
      { id: 'uniopc-cloud-workspace', title: '云端工作区', status: 'ready', tools: [{ name: 'uniopc_cloud_documents_list' }] },
      { id: 'uniopc-socials', title: '公域流量', status: 'ready', tools: [{ name: 'uniopc_socials_get_settings' }] },
      { id: 'uniopc-private-conversion', title: '私域转化', status: 'ready', tools: [{ name: 'uniopc_private_conversion_list_channels' }] },
    ],
  }, { commandMode: true })

  assert.deepEqual(
    options.map(item => item.name),
    [
      'uniopc-cloud-workspace',
      'uniopc-socials',
      'uniopc-private-conversion',
    ],
  )
})

test('buildMentionResourceOptions surfaces non-ready plugins as disabled with a reason', () => {
  const options = buildMentionResourceOptions({
    toolPlugins: [
      { id: 'uniopc-cloud-workspace', title: 'Workspace', status: 'ready', tools: [{ name: 'uniopc_cloud_documents_list' }] },
      { id: 'uniopc-socials', title: 'Socials', status: 'missing_env', readiness_reasons: ['missing_env'] },
      { id: 'uniopc-private-conversion', title: 'Conversion', status: 'unauthorized' },
    ],
  }, { commandMode: true })

  assert.deepEqual(
    options.map(item => [item.name, item.disabled, item.description]),
    [
      ['uniopc-cloud-workspace', false, '已就绪 Uniopc 引擎 Plugin'],
      ['uniopc-socials', true, '待配置(缺环境变量)'],
      ['uniopc-private-conversion', true, '未授权'],
    ],
  )
  assert.deepEqual(options[1].readinessReasons, ['missing_env'])
})

test('ready infrastructure plugins with no tools and no skills stay out of the capability menu', () => {
  const options = buildMentionResourceOptions({
    toolPlugins: [
      // gatekeeper: ready 但零工具零技能(before_tool_call hook 基础设施),不该出现死条目
      { id: 'uniopc-gatekeeper', title: '授权守门', status: 'ready', tools: [] },
      // 技能包:零工具但有技能,必须保留
      { id: 'uniopc-documents', title: '文档处理', status: 'ready', tools: [], hasSkills: true },
      // 未就绪且工具被清空(如未授权探针):必须保留并可见原因
      { id: 'uniopc-socials', title: 'Socials', status: 'unauthorized', tools: [] },
    ],
  }, { commandMode: true })

  assert.deepEqual(options.map(item => item.name), ['uniopc-documents', 'uniopc-socials'])
})

test('mergeMentionResources preserves previously loaded slash plugins while later resources arrive', () => {
  assert.deepEqual(
    mergeMentionResources({
      toolPlugins: [{ id: 'uniopc-socials', status: 'ready' }],
      mcps: [],
      skills: [],
      documents: [],
    }, {
      documents: [{ id: 'doc-1' }],
    }),
    {
      plugins: [],
      toolPlugins: [{ id: 'uniopc-socials', status: 'ready' }],
      mcps: [],
      skills: [],
      documents: [{ id: 'doc-1' }],
    },
  )
})

test('mentionResourcesLoadingAfterCoreResult lets slash plugins appear before slow MCP and Skill resources', () => {
  assert.equal(mentionResourcesLoadingAfterCoreResult({
    loading: true,
    toolPlugins: [{ id: 'uniopc-socials', status: 'ready' }],
    pendingMcp: true,
    pendingSkills: true,
  }), false)
  assert.equal(mentionResourcesLoadingAfterCoreResult({
    loading: true,
    toolPlugins: [],
    pendingMcp: true,
    pendingSkills: false,
  }), true)
})

test('filterMentionOptions narrows document-prefixed queries', () => {
  assert.deepEqual(
    filterMentionOptions('doc:短剧', [
      { kind: 'plugin', name: 'project-tools', label: 'project-tools' },
      { kind: 'doc', name: 'doc-1', label: '短剧文档' },
    ]).map(option => `${option.kind}:${option.name}`),
    ['doc:doc-1'],
  )
})

test('enrichConversationMentions keeps only authorized local document ids in structured context', () => {
  const options = buildMentionResourceOptions({
    documents: [{ id: 'doc-1', title: '投放复盘' }],
  }, { commandMode: false })

  assert.deepEqual(
    enrichConversationMentions([
      { kind: 'doc', name: 'doc-1' },
      { kind: 'doc', name: 'doc-secret' },
      { kind: 'mcp', name: 'context7' },
      { kind: 'plugin', name: 'uniopc-cloud-workspace' },
      { kind: 'skill', name: 'browser-automation' },
    ], options),
    [
      { kind: 'doc', name: 'doc-1', label: '投放复盘', summary: '' },
    ],
  )
})

test('explicit local document mentions are retained and unknown ids are removed', () => {
  const options = [{ kind: 'doc', id: 'local-1', name: 'local-1', label: '本地复盘' }]

  assert.deepEqual(
    enrichConversationMentions([
      { kind: 'doc', name: 'local-1' },
      { kind: 'doc', name: 'unknown' },
    ], options),
    [{ kind: 'doc', name: 'local-1', label: '本地复盘', summary: '' }],
  )
})

test('inferDocumentTitleMentions authorizes one uniquely named document requested in natural language', () => {
  const options = [
    { kind: 'doc', id: 'doc-1', name: 'doc-1', label: '首先。', summary: '文档摘要' },
  ]

  assert.deepEqual(
    inferDocumentTitleMentions('阅读首先这篇文章，然后根据内容改文档名字', options),
    [{ kind: 'doc', name: 'doc-1', label: '首先。', summary: '文档摘要', trigger: 'title' }],
  )
})

test('inferDocumentTitleMentions requires an operation or title quote and never guesses duplicate titles', () => {
  const options = [
    { kind: 'doc', id: 'doc-1', name: 'doc-1', label: '复盘' },
    { kind: 'doc', id: 'doc-2', name: 'doc-2', label: '复盘' },
    { kind: 'doc', id: 'doc-3', name: 'doc-3', label: '计划' },
  ]

  assert.deepEqual(inferDocumentTitleMentions('今天讨论复盘和计划', options), [])
  assert.deepEqual(inferDocumentTitleMentions('读取《复盘》', options), [])
  assert.deepEqual(inferDocumentTitleMentions('读取《计划》', options), [
    { kind: 'doc', name: 'doc-3', label: '计划', summary: '', trigger: 'title' },
  ])
})

test('inferDocumentTitleMentions leaves an explicit @ document as the sole authorization', () => {
  const options = [{ kind: 'doc', id: 'doc-1', name: 'doc-1', label: '复盘' }]
  assert.deepEqual(
    inferDocumentTitleMentions('读取《复盘》', options, [{ kind: 'doc', name: 'doc-1' }]),
    [],
  )
})

test('inferDocumentTitleMentions authorizes an explicitly requested ordinal document', () => {
  const options = [
    { kind: 'doc', id: 'doc-newest', name: 'doc-newest', label: '最新复盘' },
    { kind: 'doc', id: 'doc-second', name: 'doc-second', label: '产品计划' },
  ]

  assert.deepEqual(
    inferDocumentTitleMentions('具体看内容可以看到吗？比如第一篇', options),
    [{ kind: 'doc', name: 'doc-newest', label: '最新复盘', summary: '', trigger: 'ordinal' }],
  )
  assert.deepEqual(
    inferDocumentTitleMentions('请阅读第 2 篇', options),
    [{ kind: 'doc', name: 'doc-second', label: '产品计划', summary: '', trigger: 'ordinal' }],
  )
})

test('filterPluginMentionOptionsByProfile hides plugins disabled for the active profile', () => {
  const options = filterPluginMentionOptionsByProfile([
    { kind: 'plugin', id: 'uniopc-cloud-workspace', name: 'uniopc-cloud-workspace' },
    { kind: 'plugin', id: 'uniopc-socials', name: 'uniopc-socials' },
    { kind: 'mcp', name: 'context7' },
  ], [
    { id: 'uniopc-cloud-workspace', enabled: true },
    { id: 'uniopc-socials', enabled: false },
  ])

  assert.deepEqual(options.map(item => item.name), [
    'uniopc-cloud-workspace',
    'context7',
  ])
})

test('buildMentionContext describes only selected Document references', () => {
  assert.equal(
    buildMentionContext([
      { kind: 'plugin', name: 'xhs-insights-openclaw-plugin' },
      { kind: 'mcp', name: 'tikhub-xiaohongshu' },
      { kind: 'skill', name: 'browser-automation' },
      { kind: 'doc', name: 'doc-1', label: '投放复盘' },
    ]),
    '用户本轮显式 @ 了以下文档上下文：\n- Document: `投放复盘` (`doc-1`)\n请优先按这些 @ 引用理解用户上下文；文档不可用时，说明原因并给出替代方案。',
  )
})

test('buildToolInvocationContext describes selected slash tool invocations', () => {
  assert.equal(
    buildToolInvocationContext([
      { kind: 'plugin', name: 'uniopc-cloud-workspace' },
      { kind: 'mcp', name: 'telegram' },
    ]),
    '用户本轮显式 / 调用了以下已安装能力：\n- Uniopc 引擎 plugin: `uniopc-cloud-workspace`\n- MCP server: `telegram`\n请把这些 / 调用视为用户明确要求使用的能力。插件能力有两种形态：注册为工具(tools)，或作为技能包以 Skill 提供(如 pptx、docx、pdf)。若没有同名工具，先检查你已加载的 Skill 并直接使用，不要因为没有工具就报告插件不可用；只有工具和 Skill 都不存在时，才说明缺失的 ready 条件。',
  )
})

test('selectAgentVisibleSkills treats an empty allowlist as unrestricted, not as none assigned', () => {
  const skills = [
    { name: 'pptx', eligible: true },
    { name: 'github', eligible: true },
    { name: 'weather', eligible: true },
  ]

  // No allowlist configured -> the engine exposes every eligible skill.
  assert.deepEqual(
    selectAgentVisibleSkills(skills, new Set(), []).map(s => s.name),
    ['pptx', 'github', 'weather'],
  )

  // An explicit allowlist narrows, it does not extend.
  assert.deepEqual(
    selectAgentVisibleSkills(skills, new Set(['github']), []).map(s => s.name),
    ['github'],
  )
})

test('selectAgentVisibleSkills drops disabled and ineligible skills', () => {
  const skills = [
    { name: 'pptx', eligible: true },
    { name: 'imsg', eligible: false },
    { name: 'weather', eligible: true, disabled: true },
    { name: '', eligible: true },
  ]

  assert.deepEqual(
    selectAgentVisibleSkills(skills, new Set(), []).map(s => s.name),
    ['pptx'],
  )
})

test('selectAgentVisibleSkills hides plugin-provided skills so a capability is listed once', () => {
  const skills = [
    { name: 'pptx', eligible: true },
    { name: 'docx', eligible: true },
    { name: 'github', eligible: true },
  ]
  const plugins = [
    { id: 'uniopc-presentations', skillNames: ['pptx'] },
    { id: 'uniopc-documents', skill_names: ['docx', 'pdf'] },
  ]

  // pptx/docx are already represented by their plugin entries in the menu.
  assert.deepEqual(
    selectAgentVisibleSkills(skills, new Set(), plugins).map(s => s.name),
    ['github'],
  )
})

test('buildMentionResourceOptions labels ready skill-pack plugins by their Skill form', () => {
  const options = buildMentionResourceOptions({
    toolPlugins: [
      { id: 'uniopc-cloud-workspace', title: 'Workspace', status: 'ready', hasSkills: true, tools: [{ name: 'uniopc_cloud_context_get' }] },
      { id: 'uniopc-presentations', title: '演示文稿', status: 'ready', hasSkills: true, tools: [] },
      { id: 'uniopc-documents', title: '文档处理', status: 'ready', hasSkills: true },
    ],
  }, { commandMode: true })

  assert.deepEqual(
    options.map(item => [item.name, item.disabled, item.description]),
    [
      ['uniopc-cloud-workspace', false, '已就绪 Uniopc 引擎 Plugin'],
      ['uniopc-presentations', false, '已就绪技能包(通过 Skill 提供能力)'],
      ['uniopc-documents', false, '已就绪技能包(通过 Skill 提供能力)'],
    ],
  )
})

test('buildMentionResourceOptions reads camelCase readinessReasons from the Rust snapshot', () => {
  const options = buildMentionResourceOptions({
    toolPlugins: [
      { id: 'uniopc-socials', title: 'Socials', status: 'missing_env', readinessReasons: ['missing_env:KEY'] },
    ],
  }, { commandMode: true })

  assert.deepEqual(options[0].readinessReasons, ['missing_env:KEY'])
})

test('mention menu keeps the highlighted row visible while the list is scrolled', () => {
  // 6 rows of 60px inside a 180px viewport (3 rows visible at a time).
  const rows = offset => Array.from({ length: 6 }, (_, index) => ({
    index,
    top: index * 60 - offset,
    bottom: index * 60 + 60 - offset,
  }))
  const viewport = { top: 0, bottom: 180 }

  // Not scrolled: row 1 is already visible, selection must not jump.
  assert.equal(nearestVisibleMentionIndex({ viewport, items: rows(0), activeIndex: 1 }), 1)

  // Scrolled down past row 0 → snap forward to the topmost visible row.
  assert.equal(nearestVisibleMentionIndex({ viewport, items: rows(120), activeIndex: 0 }), 2)

  // Scrolled back up while row 5 was selected → snap to the bottom visible row.
  assert.equal(nearestVisibleMentionIndex({ viewport, items: rows(0), activeIndex: 5 }), 2)

  // Partially visible rows do not count as visible.
  assert.equal(nearestVisibleMentionIndex({ viewport, items: rows(30), activeIndex: 0 }), 1)

  // Degenerate input leaves the selection alone.
  assert.equal(nearestVisibleMentionIndex({ viewport, items: [], activeIndex: 3 }), 3)
  assert.equal(nearestVisibleMentionIndex(), 0)
})
