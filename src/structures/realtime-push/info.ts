import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'HTTP was built for the client to ask and the server to answer, so a server with news has to find a way to reach a client that did not ask. Short polling asks again and again. Long polling asks once and the server waits to answer. Server-sent events keep one response open and write events down it. WebSocket turns the connection into a two-way channel of frames. Each step cuts the delay and the wasted requests, and costs more held-open connections on the server.',
  watch: [
    'Replay short: messages arrive at ticks 2 and 7 and polls go out every 3 ticks. m1 waits 1 tick and m2 waits 2. Two of the four polls come back empty: a full request and response for nothing.',
    'Each waiting message is compared with the next poll time. That gap is the delay short polling adds, up to the whole interval.',
    'Replay long: the same two messages reach the client in the tick they arrive, and no answer is empty. Every message costs one new request, because the answer ends the held one.',
    'Sit idle under long polling: a request held 6 ticks comes back 204 No Content and is opened again at once. That is the empty response long polling still pays, once per timeout instead of once per poll.',
    'Replay sse: one request in all. Each message is a few lines, "id:" and "data:", written down the same open response.',
    'Drop with a message missed: EventSource reconnects by itself and sends Last-Event-ID, and the server sends only what came after it. Try the same under websocket: the reconnect and the "resume after" message are the application\'s own code.',
    'Client sends: under polling and SSE it is a separate POST with its own headers. Under WebSocket it is one more frame on the socket already open.',
    'The model is simplified. One client, one server, no network latency: a request and its answer happen in the same tick. The timeout is 6 ticks, heartbeats every 5, and reconnecting takes 1. Real values are seconds: think 25 to 60.',
  ],
  complexity: [
    { op: 'Short polling, per poll', average: '1 request', worst: '1 request', note: 'Whether or not there is news. Delay up to the interval, about half of it on average.' },
    { op: 'Long polling, per message', average: '1 request', worst: '1 request', note: 'The answer ends the held request, so the client opens another. Plus one empty answer per timeout while idle.' },
    { op: 'Server-sent events, per message', average: 'One event, a few bytes', worst: 'One event', note: 'No request: the response stays open. One request per (re)connection.' },
    { op: 'WebSocket, per message', average: 'One frame, 2 to 14 bytes of header', worst: 'One frame', note: 'Either direction. One HTTP request, the upgrade, per connection.' },
    { op: 'Client to server', average: 'POST under polling and SSE', worst: 'One frame under WebSocket', note: 'Only WebSocket carries data both ways on one connection.' },
    { op: 'Idle client', average: 'Short polling: 1 request per interval', worst: 'Others: 1 open connection', note: 'Held connections cost memory and a socket. Heartbeats cost a few bytes every so often.' },
  ],
  space:
    'One open connection per online client for long polling, SSE and WebSocket: a socket, kernel buffers and whatever the server keeps per client. Short polling holds nothing between polls. Measure the per-connection cost on your own stack; as an assumption, at 20 KB each, a million connections need 20 GB across the fleet.',
  usedIn: [
    {
      name: 'Telegram Bot API',
      how: 'getUpdates is long polling: a timeout parameter tells the server how long to hold the request when there are no updates. Webhooks are the alternative.',
    },
    {
      name: 'Amazon SQS',
      how: 'ReceiveMessage supports long polling with WaitTimeSeconds of up to 20 seconds, which cuts the empty responses short polling would return and bill.',
    },
    {
      name: 'HashiCorp Consul',
      how: 'Blocking queries are long polls: the client passes the last index it saw and a wait time, and the server answers when the data changes past that index or the wait runs out.',
    },
    {
      name: 'OpenAI and Anthropic APIs',
      how: 'Streamed completions are sent as server-sent events, one event per piece of output, over a single HTTP response.',
    },
    {
      name: 'Socket.IO',
      how: 'Its transport layer, Engine.IO, starts on HTTP long polling and upgrades to WebSocket when it can, so it still works behind proxies that block WebSocket. Its Redis adapter relays broadcasts between servers.',
    },
    {
      name: 'Slack and Discord',
      how: 'Clients and bots hold a WebSocket to a gateway and receive events over it: Slack\'s Socket Mode and RTM API, Discord\'s Gateway. Discord\'s Gateway sends a heartbeat interval and expects heartbeats back.',
    },
  ],
  reachFor: [
    'Server-sent events for one-way feeds: notifications, live scores, dashboards, progress bars and streamed model output. Plain HTTP, reconnect and resume built in.',
    'WebSocket for two-way, frequent, low-latency traffic: chat, collaborative editing, multiplayer games, trading screens.',
    'Long polling for simple or old clients, or networks where long-lived streams are blocked. It is plain request and response, so every proxy understands it.',
    'Short polling when updates are rare and a delay of the interval is fine: a status page that refreshes every 30 seconds, a job that finishes in minutes. Cacheable, stateless, trivially scaled.',
  ],
  costs: [
    'Header overhead. Every poll carries a full set of HTTP headers each way, often several hundred bytes and more with cookies. Short polling pays it even when there is nothing to say; an SSE event or WebSocket frame pays a few bytes.',
    'Connection limits. Browsers allow about six HTTP/1.1 connections per origin, so a few tabs each holding an SSE stream or long poll can starve the page of connections. HTTP/2 carries many streams on one connection and lifts this for SSE. WebSocket over HTTP/1.1 takes its own connection.',
    'Proxies and load balancers. Many close connections that are idle too long: nginx\'s proxy_read_timeout defaults to 60 seconds, as does the idle timeout of an AWS Application Load Balancer. Send heartbeats inside that limit, hold long polls for less, and expect some proxies to buffer or block streaming.',
    'Sticky state. A held connection lives on one server. Deploys, scaling in and server crashes drop thousands of clients at once, and they all reconnect together: add jitter to the retry.',
    'One connection per online client. Plan file descriptors, memory per connection and, behind one load balancer address, the number of source ports to each backend.',
    'A message must reach the server that holds the recipient\'s connection. With many gateway servers you need a pub/sub backbone, such as Redis pub/sub or Kafka, between them, or a registry of which gateway holds which user.',
    'Back-pressure. If a client reads slower than you send, its buffer grows on the server. Bound the queue per connection and drop, merge or disconnect slow consumers. In the browser, WebSocket\'s bufferedAmount shows what is still queued to send.',
    'WebSocket and SSE resume differently. SSE resumes by Last-Event-ID if the server keeps recent events. WebSocket has no resume: design a sequence number into your messages and a "since" request.',
  ],
  interview: [
    'Start from the requirement: who sends, how often, and how late is too late. One-way and occasional is SSE or even polling. Two-way and chatty is WebSocket.',
    'Short polling delay: with interval T the average wait is about T ÷ 2 and the worst is T. A million clients polling every 5 seconds is 200,000 requests a second, most of them empty.',
    'Long polling removes the delay and the empty answers, but one message still costs one request, and a held request must come back before the proxy\'s idle timeout.',
    'SSE is a normal HTTP response that never ends, with Content-Type text/event-stream. It is text only and one way. The browser\'s EventSource reconnects on its own and sends Last-Event-ID, so keep recent events by id to resume.',
    'WebSocket starts as an HTTP GET with Upgrade: websocket and a 101 Switching Protocols answer, then carries frames both ways. Ping and pong frames keep it alive. Over HTTP/2 it can run as a stream, by RFC 8441, where both ends support it.',
    'Authenticate the upgrade. The browser WebSocket API cannot set an Authorization header, so use a cookie, a short-lived token in the URL or in the first message, and check the Origin header to stop cross-site WebSocket hijacking.',
    'Architecture: clients connect to a fleet of stateless-looking gateway servers that hold connections. A message for user U goes on a pub/sub bus; the gateway holding U\'s connection delivers it. Keep a presence table of user to gateway if fan-out to every gateway is too costly.',
    'Delivery guarantees are yours to build. Give each message a sequence number per conversation, let the client say what it has on reconnect, and store messages durably before pushing, so a dropped connection loses nothing.',
    'Mention the newer options in one breath: WebRTC data channels connect browsers to each other, and WebTransport runs over HTTP/3 with streams and unreliable datagrams.',
  ],
};
