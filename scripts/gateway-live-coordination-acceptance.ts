import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LeafProcess } from '../src/utils/leafProcess.ts'
import { listGatewayPeers, sendGatewayHookMessage } from '../src/utils/gatewaySessionTransport.ts'

const candidate = process.env.GATEWAY_ACCEPTANCE_CANDIDATE
if (!candidate || !process.argv.includes('--run')) throw new Error('Explicit candidate and --run required')
const directory = await mkdtemp(join(tmpdir(), 'gateway-coordination-release-'))
const sessions = join(directory, 'gateway-sessions')
const gate = join(directory, 'gate')
await mkdir(gate)
const helper = join(gate, 'server.mjs')
const config = join(gate, 'mcp.json')
await writeFile(helper, `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))}
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))}
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))}
import { access, writeFile } from 'node:fs/promises'
const server = new Server({name:'gate',version:'1'}, {capabilities:{tools:{}}})
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'wait_for_release',description:'Wait at a bounded verification boundary',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}))
server.setRequestHandler(CallToolRequestSchema, async () => {
  await writeFile(process.env.GATE_ENTERED, 'entered')
  const end = Date.now()+90000
  while(Date.now()<end){
    try {await access(process.env.GATE_RELEASE); return {content:[{type:'text',text:'Gate released. Continue.'}]}} catch {}
    await new Promise(r=>setTimeout(r,25))
  }
  return {isError:true,content:[{type:'text',text:'Gate deadline expired'}]}
})
await server.connect(new StdioServerTransport())
`)
await writeFile(config, JSON.stringify({mcpServers:{gate:{command:process.execPath,args:[helper],env:{GATE_ENTERED:join(gate,'entered'),GATE_RELEASE:join(gate,'release')}}}}))
type Chat = { id: string; events: any[]; process: LeafProcess }
const chats: Chat[] = []
let phase = 'startup'
const results = (chat: Chat) => chat.events.filter(event => event.type === 'result')
const textBeforeResult = (chat: Chat, start: number) => {
  const slice = chat.events.slice(start)
  const end = slice.findIndex(event => event.type === 'result')
  assert.ok(end >= 0)
  return slice.slice(0,end).filter(event=>event.type==='assistant').flatMap(event=>event.message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
}
async function wait(check: () => boolean | Promise<boolean>, label: string) {
  phase = label
  const deadline = Date.now()+120000
  while (!(await check())) {
    for (const chat of chats) {
      assert.equal(chat.process.getPermissions().length,0,'Unexpected permission request')
      assert.ok(!['failed','closed'].includes(chat.process.getState()),'Chat exited')
    }
    if(Date.now()>deadline) throw new Error('Acceptance deadline')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
}
async function inbox(chat: Chat) {
  try { return JSON.parse(await readFile(join(sessions,`${chat.id}.inbox`),'utf8')) }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return {records:[],history:[]}; throw error }
}
async function send(from: Chat, to: Chat, text: string) {
  const registration = JSON.parse(await readFile(join(sessions,`${from.id}.json`),'utf8'))
  return await sendGatewayHookMessage({GATEWAY_PEER_DIRECTORY:sessions,GATEWAY_PEER_SESSION:from.id,GATEWAY_PEER_RUNTIME:registration.peer.runtimeId,GATEWAY_PEER_TOKEN:registration.token},to.id,text) as {id:string;state:string}
}
try {
  for(let index=0;index<2;index++) {
    const id=randomUUID(), events:any[]=[]
    const model = index === 0 ? (globalThis.process.env.GATEWAY_SENDER_MODEL ?? 'gateway-gpt-terra') : (globalThis.process.env.GATEWAY_RECEIVER_MODEL ?? 'gateway-gpt-terra')
    console.log(JSON.stringify({ chat: index, model }))
    const process = new LeafProcess({executable:'powershell.exe',args:['-NoProfile','-File',resolve(import.meta.dir, 'cc.ps1'),'--print','--verbose','--input-format','stream-json','--output-format','stream-json','--permission-prompt-tool','stdio','--session-id',id,'--model',model,'--max-turns','8','--mcp-config',config,'--strict-mcp-config','--tools','Skill,Read,Write','--allowedTools',`Skill(gateway-peers),Read(${directory.replace(/\\/g, '/')}/**),mcp__gate__wait_for_release`],cwd:directory,env:{...globalThis.process.env,CLAUDE_CONFIG_DIR:directory,CC_RAW_ARGS:undefined,CC_CLAUDE_SCRIPT_OVERRIDE:resolve(candidate),MODEL_GATEWAY_DEFAULT:model,MODEL_GATEWAY_EFFORT:'medium',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},onEvent:event=>events.push(event),onState:()=>{}})
    chats.push({id,events,process})
    await process.start()
  }
  const [a,b]=chats as [Chat,Chat]
  await wait(async()=> (await listGatewayPeers(sessions)).length===2,'discovery')
  const discoveredPeers = await listGatewayPeers(sessions)
  assert.equal(discoveredPeers.length, 2)
  assert.ok(discoveredPeers.some(peer => peer.sessionId === b.id))
  for(const [index,chat] of chats.entries()) {
    const count=results(chat).length
    chat.process.send(`You are local coordination verifier ${index}. You may read fixture files in this temporary directory and answer peer requests within that scope. Do not change files or permissions. Follow each new peer request's requested response destination: if it asks for a local answer or says no peer reply, answer locally without sending. If it asks for a peer reply, send exactly one correlated reply using replyTo. Never send acknowledgement loops or reply to replies. After a successful peer send, finish locally with LOCAL_SEND_DONE. For now reply READY_${index} only.`)
    await wait(()=>results(chat).length>count,'initialize_chat')
    assert.equal(results(chat).at(-1)?.subtype,'success')
    assert.equal(results(chat).at(-1)?.is_error,false)
  }
  await wait(()=>chats.every(chat=>chat.events.some(event=>event.type==='system'&&event.subtype==='init')),'init_events')
  for(const chat of chats) {
    const init=chat.events.find(event=>event.type==='system'&&event.subtype==='init')
    assert.ok(init.tools.includes('Skill'))
    assert.ok(init.tools.includes('mcp__gate__wait_for_release'))
  }
  const bStart=b.events.length, aStart=a.events.length
  a.process.send(`Use Skill gateway-peers list to discover the other session, then send exactly one question to the other session. The other session ID is ${b.id}; use that exact toSessionId, not your own session ID. Ask which file it would own in a hypothetical split: you own a.txt and it owns b.txt. Ask it to reply through gateway-peers with replyTo and B_OWNS_B. Do not write files. Do not send follow-up acknowledgements or peer messages after the successful send; finish with the local final marker LOCAL_SEND_DONE.`)
  await wait(async()=> (await inbox(a)).records.some((r:any)=>r.message.text.includes('B_OWNS_B')&&r.message.replyTo),'model_reply')
  await wait(()=>a.events.slice(aStart).some(e=>e.type==='result')&&b.events.slice(bStart).some(e=>e.type==='result'),'coordination_complete')
  assert.ok(a.events.slice(aStart).some(e=>e.type==='assistant'&&e.message?.content?.some((block:any)=>block.type==='tool_use'&&block.name==='Skill'&&block.input?.skill==='gateway-peers'&&block.input.args==='list')))
  const firstSuccessfulResult = (chat: Chat, start: number) => chat.events.slice(start).find(e=>e.type==='result'&&e.subtype==='success'&&e.is_error===false)
  const firstResultText = (chat: Chat, start: number) => {
    const result = firstSuccessfulResult(chat, start)
    assert.ok(result, 'Expected a successful coordination result')
    const resultIndex = chat.events.indexOf(result)
    return chat.events.slice(start, resultIndex).filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('\n')
  }
  assert.ok(firstResultText(a, aStart).includes('LOCAL_SEND_DONE'))
  assert.ok(firstResultText(b, bStart).includes('LOCAL_SEND_DONE'))
  const peerSends = (chat: Chat, start: number) => chat.events.slice(start).filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter((block:any)=>block.type==='tool_use'&&block.name==='Skill'&&block.input?.skill==='gateway-peers'&&block.input.args?.startsWith('send'))
  assert.equal(peerSends(a, aStart).length,1)
  assert.equal(peerSends(b, bStart).length,1)
  assert.ok(firstSuccessfulResult(a, aStart))
  assert.ok(firstSuccessfulResult(b, bStart))
  console.log('REAL_DISCOVERY_AND_ATTRIBUTED_REPLY=PASS')
  const start=b.events.length, count=results(b).length
  b.process.send('Call mcp__gate__wait_for_release once. After it returns, act on any automatically arriving peer message and include its requested marker in your local final answer. Only reply to a peer message if it explicitly asks a question; this message does not. Never send a peer reply to a message with a Reply-to message field or an acknowledgement. After any successful peer send, finish with LOCAL_SEND_DONE and do not send another peer message. Do not read or poll the inbox, use other tools, or send peer replies in this turn.')
  await wait(async()=>{try{await access(join(gate,'entered'));return true}catch{return false}},'busy_gate_entered')
  const marker=`BUSY_${randomUUID()}`
  const receipt=await send(a,b,`For this verification, include exactly this marker in your next final answer: ${marker}. No peer reply needed.`)
  assert.equal(receipt.state,'queued')
  assert.equal(results(b).length,count)
  await writeFile(join(gate,'release'),'release')
  await wait(()=>results(b).length>count,'busy_first_result')
  assert.ok(textBeforeResult(b,start).includes(marker),'Peer marker must appear before the original busy turn ends')
  assert.equal(results(b).at(-1)?.subtype,'success')
  assert.equal(results(b).at(-1)?.is_error,false)
  assert.equal((await inbox(b)).records.find((r:any)=>r.message.id===receipt.id)?.state,'delivered')
  assert.equal(b.events.slice(start).filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter((block:any)=>block.type==='tool_use'&&block.name?.startsWith('mcp__gate__')).length,1)
  assert.equal(peerSends(b, start).length,0)
  console.log('REAL_BUSY_BOUNDARY_DELIVERY=PASS')
  const idleStart=b.events.length, idleCount=results(b).length, idleMarker=`IDLE_${randomUUID()}`
  const idle=await send(a,b,`What is the verification marker ${idleMarker}? Answer with only ${idleMarker} in your local final answer. Do not send a peer message.`)
  assert.equal(idle.state,'queued')
  await wait(()=>results(b).length>idleCount,'idle_wake')
  assert.ok(textBeforeResult(b,idleStart).includes(idleMarker), 'IDLE_MARKER_MISSING')
  assert.equal(results(b).at(-1)?.subtype,'success')
  assert.equal(results(b).at(-1)?.is_error,false)
  assert.equal((await inbox(b)).records.find((r:any)=>r.message.id===idle.id)?.state,'delivered')
  assert.equal(b.events.slice(idleStart).filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter((block:any)=>block.type==='tool_use'&&block.name==='Skill'&&block.input?.skill==='gateway-peers'&&block.input.args?.startsWith('send')).length,0)
  assert.ok((await inbox(a)).history?.some((r:any)=>r.direction==='sent'))
  assert.equal(peerSends(b, idleStart).length,0)
  console.log('REAL_IDLE_WAKE_AND_HISTORY=PASS')
  const rounds = Number(process.env.GATEWAY_EVERYDAY_ROUNDS ?? 8)
  const measurements: number[] = []
  for (let round = 0; round < rounds; round++) {
    await wait(async () => {
      const peers = await listGatewayPeers(sessions)
      return peers.length === 2 && peers.every(peer => peer.status === 'idle')
    }, 'everyday_idle_boundary')
    const values = Array.from({ length: 5 }, () => 10 + Math.floor(Math.random() * 80))
    const expected = values.reduce((sum, value) => sum + value, 0)
    const marker = `WORK_${randomUUID()}`
    const file = join(directory, `data-${round}.json`)
    await writeFile(file, JSON.stringify({ label: 'café 世界', values }))
    const beforeA = a.events.length, beforeB = b.events.length, started = performance.now()
    a.process.send(`Delegate this one question to peer ${b.id} through gateway-peers send: Read ${JSON.stringify(file)} and compute the sum of its values array. Reply to you via gateway-peers with replyTo set to that incoming request ID, including ${marker} and SUM=<computed number>. You must not read the file or calculate it yourself. Send exactly once, then finish locally. No acknowledgement replies.`)
    await wait(async () => (await inbox(b)).records.some((record: any) => record.message.text.includes(marker)), 'everyday_request')
    const request = (await inbox(b)).records.find((record: any) => record.message.text.includes(marker))
    await wait(async () => (await inbox(a)).records.some((record: any) => record.message.replyTo === request.message.id && record.message.text.includes(marker)), 'everyday_correlated_reply')
    const reply = (await inbox(a)).records.find((record: any) => record.message.replyTo === request.message.id && record.message.text.includes(marker))
    assert.match(reply.message.text, new RegExp(`SUM=\\s*${expected}\\b`))
    assert.ok(b.events.slice(beforeB).some(event => event.type === 'assistant' && event.message?.content?.some((block: any) => block.type === 'tool_use' && block.name === 'Read' && block.input?.file_path === file)), 'Receiver must actually read the task file')
    await wait(async () => (await listGatewayPeers(sessions)).every(peer => peer.status === 'idle'), 'everyday_completion')
    assert.equal(peerSends(a, beforeA).length, 1)
    assert.equal(peerSends(b, beforeB).length, 1)
    measurements.push(Math.round(performance.now() - started))
    console.log(JSON.stringify({ everydayRound: round + 1, correctResult: true, fileRead: true, correlatedReply: true, sends: 2, elapsedMs: measurements.at(-1) }))
  }
  console.log(JSON.stringify({ everydayPassed: measurements.length, elapsedMs: measurements }))
} catch(error) {
  const code=(error as any)?.code
  console.error(JSON.stringify({result:'fail',phase,code:typeof code==='string'&&/^[A-Z_]+$/.test(code)?code:'unclassified',chats:chats.map(chat=>({state:chat.process.getState(),permissions:chat.process.getPermissions().map(p=>p.tool),results:results(chat).map(r=>({subtype:r.subtype,is_error:r.is_error})),apiErrors:chat.events.filter(e=>e.type==='system'&&e.subtype==='api_retry').map(e=>({errorStatus:e.errorStatus,errorType:e.errorType,attempt:e.attempt})),tools:chat.events.filter(e=>e.type==='assistant').flatMap(e=>e.message?.content??[]).filter(b=>b.type==='tool_use').map(b=>({name:b.name,skill:b.input?.skill}))}))}))
  process.exitCode=1
} finally {
  await Promise.all(chats.map(chat=>chat.process.close()))
  console.log(`EVIDENCE_DIRECTORY=${directory}`)
}
