// A stand-in browser for the launch-window proof: binds the debugging port
// after a delay and serves one fixed browser GUID. Never Chrome.
//   node stub-browser.mjs <port> <delayMs> <guid> [--user-data-dir=...]
import http from 'node:http'

const port = Number(process.argv[2] || 0)
const delay = Number(process.argv[3] || 0)
const guid = process.argv[4] || 'd0d0d0d0-1111-2222-3333-444455556666'
await new Promise(resolve => setTimeout(resolve, delay))
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  // guid '-' means: answer, but serve no webSocketDebuggerUrl - the shape of a
  // browser that has bound the port and has not published a GUID yet.
  if (guid === '-') {
    response.end(JSON.stringify({ Browser: 'Stub/1.0', 'Protocol-Version': '1.3' }))
    return
  }
  response.end(JSON.stringify({ Browser: 'Stub/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${guid}` }))
})
server.listen(port, '127.0.0.1', () => process.stdout.write('listening\n'))
process.on('SIGTERM', () => process.exit(0))
