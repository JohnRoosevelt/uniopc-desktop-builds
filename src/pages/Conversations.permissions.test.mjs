import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
const source = fs.readFileSync(new URL('./Conversations.jsx', import.meta.url), 'utf8')
const functions = {}
let drain
let poll
let gatewayEvent
let sendBoundary
const traverse = traverseModule.default ?? traverseModule
traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
  FunctionDeclaration({ node }) { functions[node.id?.name] = source.slice(node.start, node.end) },
  CallExpression({ node }) {
    if (node.callee.name === 'sendConversationTurn') sendBoundary = source.slice(node.start, node.end)
    if (node.callee.name === 'listen' && node.arguments[0]?.value === 'conversation-gateway-event') gatewayEvent = source.slice(node.arguments[1].start, node.arguments[1].end)
    if (node.callee.name !== 'useEffect') return
    const body = source.slice(node.arguments[0].start, node.arguments[0].end)
    if (body.includes('claimQueuedConversationOutbox(')) drain = body
    if (body.includes('listExecApprovals(')) poll = body
  },
})
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise, resolve, reject} }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function harness() {
  const mod = await import('../lib/conversationPermissionCoordinator.js')
  const state = { mode: 'full', sessions: [{sessionKey:'a',permissionMode:'full'}], calls: [], approvals: [] }
  const context = vm.createContext({
    activeProfile:'p', activeConversationSessionKey:'a', approvalMode:'full',
    permissionCoordinatorRef:{current:mod.createConversationPermissionCoordinator?.()},
    permissionScopeRef:{current:{profile:'p',sessionKey:'a'}},
    execApprovalRefreshRef:{current:{profile:'p', revision:0, request:0}},
    sessionListRequestRef:{current:0},
    setResolvingExecApprovalId:()=>{},
    setPermissionSaveVersion:()=>{}, setApprovalMode:v=>{state.mode=v},
    setApprovalMenuOpen:()=>{},setChatNotice:()=>{},setError:()=>{},
    findConversationApprovalMode:id=>({id,label:id}),
    setConversationSessions:fn=>{state.sessions=fn(state.sessions)},
    setConversationSessionPermission:args=>{const d=deferred();state.calls.push({args,...d});return d.promise},
    gatewayReady:true, window:{setInterval:()=>1,clearInterval:()=>{}},
    engineClient:{sessions:{listExecApprovals:()=>{const d=deferred();state.calls.push(d);return d.promise}}},
    setPendingExecApprovals:value=>{state.approvals=typeof value==='function'?value(state.approvals):value},
  })
  return {state,context,choose:vm.runInContext(`(${functions.chooseConversationPermission})`,context)}
}
test('late permission failure cannot change another session', async()=>{
 const {state,context,choose}=await harness()
 const pending=choose('read-only');await tick()
 context.activeConversationSessionKey='b';context.permissionScopeRef.current={profile:'p',sessionKey:'b'};state.mode='read-only'
 state.calls[0].reject(new Error('denied'));await pending
 assert.equal(state.mode,'read-only')
})
test('permission writes serialize so an old ACK cannot overwrite the latest choice',async()=>{
 const {state,choose}=await harness()
 const first=choose('full');const second=choose('read-only');await tick()
 assert.equal(state.calls.length,1)
 state.calls[0].resolve();await tick();assert.equal(state.calls.length,2)
 state.calls[1].resolve();await Promise.all([first,second])
 assert.equal(state.sessions[0].permissionMode,'read-only')
})
test('pending permission blocks direct send and queue drain before either starts',async()=>{
 const {context,choose,state}=await harness();const pending=choose('default');await tick()
 let sends=0;let claims=0
 Object.assign(context,{input:'hello',imageAttachments:[],activeTarget:{},activeEmployee:{id:'emp'},activeConversationRouteReady:true,conversationModelReady:true,activeConversationId:'c',turnInFlight:false,conversationOwnerId:'o',storageOwnerId:'o',claimQueuedConversationOutbox:()=>{claims++;return null},validateConversationImageAttachments:()=>{},shouldQueueConversationSubmission:()=>{sends++;throw new Error('submission reached before permission confirmation')}})
 await vm.runInContext(`(${functions.sendMessage})`,context)(null)
 vm.runInContext(`(${drain})`,context)()
 assert.equal(sends,0);assert.equal(claims,0)
 state.calls[0].resolve();await pending
 vm.runInContext(`(${drain})`,context)()
 assert.equal(claims,1)
})
test('poll issued before a resolution or live request cannot replace current approvals',async()=>{
 const {context,state}=await harness()
 vm.runInContext(`(${poll})`,context)()
 context.disposed=false
 vm.runInContext(`(${gatewayEvent})`,context)({payload:{state:'exec_approval_requested',profile:'p',approvalRequest:{id:'new-event'}}})
 state.calls[0].resolve([{id:'denied'}]);await tick()
 assert.equal(state.approvals.length,1);assert.equal(state.approvals[0].id,'new-event')
})

test('failure holds queued sends until a successful save or fresh authoritative read',async()=>{
 const {context,state,choose}=await harness()
 const pending=choose('read-only');await tick();state.calls[0].reject(new Error('timeout'));await pending
 const coordinator=context.permissionCoordinatorRef.current
 assert.equal(coordinator.blocked('p','a'),true)
 coordinator.observe('p',[{sessionKey:'a',permissionMode:'full'}],0)
 assert.equal(coordinator.blocked('p','a'),true)
 coordinator.observe('p',[{sessionKey:'a',permissionMode:'read-only'}],coordinator.snapshot())
 assert.equal(coordinator.blocked('p','a'),false)
 assert.equal(coordinator.mode('p','a'),'read-only')
})
test('stale lists cannot undo saves, and search omissions retain confirmed permission',async()=>{
 const {context,state,choose}=await harness()
 const coordinator=context.permissionCoordinatorRef.current
 const before=coordinator.snapshot()
 const pending=choose('read-only');await tick();state.calls[0].resolve();await pending
 assert.equal(coordinator.observe('p',[{sessionKey:'a',permissionMode:'full'}],before)[0].permissionMode,'read-only')
 coordinator.observe('p',[],coordinator.snapshot())
 assert.equal(coordinator.mode('p','a'),'read-only')
 assert.equal(coordinator.mode('other','a'),'default')
})
test('resolved approval invalidates pending lists through the actual resolve handler',async()=>{
 const {context,state}=await harness()
 context.resolvingExecApprovalId=''
 const resolution=deferred()
 context.engineClient.sessions.resolveExecApproval=()=>resolution.promise
 vm.runInContext(`(${poll})`,context)()
 state.approvals=[{id:'denied'}]
 const resolve=vm.runInContext(`(${functions.resolvePendingExecApproval})`,context)({id:'denied'},'deny')
 resolution.resolve();await resolve
 state.calls[0].resolve([{id:'denied'}]);await tick()
 assert.equal(state.approvals.length,0)
})

test('newer approval list wins when overlapping polls finish out of order',async()=>{
 const {context,state}=await harness()
 let refresh
 context.window.setInterval=fn=>{refresh=fn;return 1}
 vm.runInContext(`(${poll})`,context)()
 refresh()
 state.calls[1].resolve([{id:'new'}]);await tick()
 state.calls[0].resolve([{id:'old'}]);await tick()
 assert.equal(state.approvals[0].id,'new')
})
test('successful explicit default unblocks queue only after clearing the override',async()=>{
 const {context,state,choose}=await harness()
 const coordinator=context.permissionCoordinatorRef.current
 coordinator.observe('p',[{sessionKey:'a',permissionMode:'full'}],coordinator.snapshot())
 const pending=choose('default');await tick()
 assert.equal(coordinator.mode('p','a'),'full')
 assert.equal(coordinator.blocked('p','a'),true)
 assert.equal(state.calls[0].args.permissionMode,'default')
 state.calls[0].resolve();await pending
 assert.equal(coordinator.mode('p','a'),'default')
 assert.equal(coordinator.blocked('p','a'),false)
})

test('a fresh list showing the old permission cannot release a failed downgrade',async()=>{
 const {context,state,choose}=await harness()
 const coordinator=context.permissionCoordinatorRef.current
 coordinator.observe('p',[{sessionKey:'a',permissionMode:'full'}],coordinator.snapshot())
 const pending=choose('read-only');await tick()
 state.calls[0].reject(new Error('ambiguous timeout'));await pending
 coordinator.observe('p',[{sessionKey:'a',permissionMode:'full'}],coordinator.snapshot())
 assert.equal(coordinator.blocked('p','a'),true)
 let claims=0
 Object.assign(context,{activeEmployee:{id:'emp'},activeConversationId:'c',turnInFlight:false,conversationModelReady:true,activeConversationRouteReady:true,conversationOwnerId:'o',storageOwnerId:'o',claimQueuedConversationOutbox:()=>{claims++;return null}})
 vm.runInContext(`(${drain})`,context)()
 assert.equal(claims,0)
 const retry=choose('read-only');await tick();state.calls[1].resolve();await retry
 vm.runInContext(`(${drain})`,context)()
 assert.equal(claims,1)
})

test('slow approval polling still applies a response while a newer poll is pending',async()=>{
 const {context,state}=await harness()
 let refresh
 context.window.setInterval=fn=>{refresh=fn;return 1}
 vm.runInContext(`(${poll})`,context)()
 refresh()
 state.calls[0].resolve([{id:'pending-visible'}]);await tick()
 assert.equal(state.approvals[0]?.id,'pending-visible')
 state.calls[1].resolve([]);await tick()
 assert.equal(state.approvals.length,0)
})

test('direct and queued sends leave permissions with Gateway instead of replaying an earlier snapshot',async()=>{
 const clientSource=fs.readFileSync(new URL('../lib/conversations/client.js',import.meta.url),'utf8')
 const start=clientSource.indexOf('export async function sendConversationTurn(')
 const end=clientSource.indexOf('export async function abortConversationTurn(',start)
 const actualClient=clientSource.slice(start,end).replace('export ','')
 for(const queued of [null,{approvalMode:'full'}]){
  let request
  const context=vm.createContext({
   activeEmployee:{id:'emp'},text:'test',attachments:[],activeConversationId:'c',activeConversationSessionKey:'a',activeProfile:'p',turnId:'turn',mentions:[],toolInvocations:[],approvalMode:'full',confirmedApprovalMode:'full',fromQueue:queued,
   conversationImageAttachmentsToGateway:()=>[],CONVERSATION_RUNTIME:{mode:'gateway_native',transport:'gateway_websocket'},
   engineClient:{sessions:{sendTurn:async({req})=>{request=req;return {}}}},
  })
  vm.runInContext(actualClient,context)
  await vm.runInContext(sendBoundary,context)
  assert.equal(request.sessionKey,'a')
  assert.equal(request.approvalMode,null,'a send must not patch a captured full mode over a later downgrade')
 }
})
