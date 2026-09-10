import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { LeafProcess } from '../src/utils/leafProcess.ts'

const fixture = `
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:x.request_id}});
 if(x.type==='user') send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Write',input:{text:x.message.content}}});
 if(x.type==='control_response') {send({type:'assistant',message:{content:[{type:'text',text:x.response.response.behavior}]}});send({type:'result'});}
});`

test('stream-json print launchers receive a bootstrap frame before control initialize', { timeout: 30000 }, async () => {
  const launcherFixture = `
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let first;
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const x=JSON.parse(line);
 first ??= x;
 if(first !== x && first?.type !== 'keep_alive') { process.stderr.write('launcher rejected stdin before control initialize\\n'); process.exit(17); }
 if(x.type==='control_request' && x.request?.subtype==='initialize') {
  if(first?.type !== 'keep_alive') { process.stderr.write('missing stream-json bootstrap\\n'); process.exit(18); }
  send({type:'control_response',response:{subtype:'success',request_id:x.request_id}});
 }
});`
  const events: Record<string, unknown>[] = []
  const child = new LeafProcess({ executable: process.execPath, args: ['-e', launcherFixture, '--', '--print', '--input-format', 'stream-json'], cwd: process.cwd(), env: process.env, onEvent: event => events.push(event), onState: () => {} })
  try {
    await child.start()
    assert.equal(child.getState(), 'idle')
    assert.deepEqual(events, [])
  } finally { await child.close() }
})

test('closing a leaf immediately rejects new turns and controls', { timeout: 10000 }, async () => {
  const child = new LeafProcess({ executable: 'node', args: ['-e', fixture + `\nsetTimeout(()=>{},300);`], cwd: process.cwd(), env: process.env, onEvent: () => {}, onState: () => {} })
  await child.start()
  const closing = child.close()
  try {
    assert.throws(() => child.send('must not reach a closing stdin'), /closing|running|idle/)
    await assert.rejects(child.checkpoint(), /closing|running/)
  } finally { await closing }
})

test('close removes descendants even when their parent exits cleanly', { timeout: 30000, skip: process.platform !== 'win32' }, async () => {
  let descendant = 0
  const orphanFixture = `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore'});
child.unref();
process.stdout.write(JSON.stringify({type:'descendant',pid:child.pid})+'\\n');
${fixture}
`
  const child = new LeafProcess({ executable: 'node', args: ['-e', orphanFixture], cwd: process.cwd(), env: process.env, onEvent: event => { if (event.type === 'descendant') descendant = Number(event.pid) }, onState: () => {} })
  try {
    await child.start()
    assert.ok(descendant > 0)
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const alive = async () => {
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-Process -Id ${descendant} -ErrorAction SilentlyContinue).Count`], { timeout: 10000, windowsHide: true })
      return result.stdout.trim() === '1'
    }
    assert.equal(await alive(), true)
    await child.close()
    assert.equal(await alive(), false, 'A descendant must not outlive close after a graceful parent exit')
  } finally {
    await child.close()
    if (descendant) { try { process.kill(descendant) } catch {} }
  }
})

test('close before start prevents creating a new process', async () => {
  const child = new LeafProcess({ executable: 'node', args: ['-e', fixture], cwd: process.cwd(), env: process.env, onEvent: () => {}, onState: () => {} })
  await child.close()
  try {
    await assert.rejects(child.start(), /closing|closed/)
    assert.equal(Boolean((child as any).child), false, 'Closed instance must not spawn a child')
  } finally { await child.close() }
})

test('concurrent forced shutdown waits for all owned process exits', { timeout: 30000 }, async () => {
  for (let round = 0; round < 3; round++) {
    const children = Array.from({ length: 5 }, () => new LeafProcess({ executable: 'node', args: ['-e', fixture + '\nsetInterval(()=>{},1000);'], cwd: process.cwd(), env: process.env, onEvent: () => {}, onState: () => {} }))
    try {
      await Promise.all(children.map(child => child.start()))
      await Promise.all(children.map(child => child.close()))
      for (const child of children) assert.ok(['closed', 'failed'].includes(child.getState()))
    } finally { await Promise.all(children.map(child => child.close())) }
  }
})

test('late result cannot resurrect a failed leaf', () => {
  const child = new LeafProcess({ executable: 'node', args: [], cwd: process.cwd(), env: process.env, onEvent: () => {}, onState: () => {} })
  ;(child as any).fail()
  ;(child as any).handle({ type: 'result' })
  assert.equal(child.getState(), 'failed')
})

test('isolated child processes retain independent permission requests and concurrent turns', { timeout: 30000 }, async () => {
  const events: Record<string, unknown>[][] = [[], []]
  const waiters: (() => void)[] = []
  const children = events.map((list, i) => new LeafProcess({ executable: 'node', args: ['-e', fixture], cwd: process.cwd(), env: process.env, onEvent: e => { list.push(e); if (e.type === 'result') waiters[i]?.() }, onState: () => {} }))
  try {
    await Promise.all(children.map(c => c.start()))
    const approved = children.map((_, i) => new Promise<void>(resolve => { waiters[i] = resolve }))
    children[0]!.send('first')
    children[1]!.send('second')
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000
      const timer = setInterval(() => {
        if (children.every(c => c.getPermissions().length === 1)) { clearInterval(timer); resolve() }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('permission not received')) }
      }, 10)
    })
    assert.equal(children[0]!.getPermissions()[0]!.input.text, 'first')
    assert.equal(children[1]!.getPermissions()[0]!.input.text, 'second')
    children[0]!.approve('permission', false)
    assert.equal(children[1]!.getState(), 'awaiting-approval')
    children[1]!.approve('permission', true)
    await Promise.all(approved)
    assert.ok(children.every(c => c.getState() === 'idle'))
    assert.throws(() => children[0]!.approve('permission', true), /expired/)
    await children[0]!.interrupt()
  } finally { await Promise.all(children.map(c => c.close())) }
})
