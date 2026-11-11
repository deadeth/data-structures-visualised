import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A load balancer sits at one address in front of a pool of servers and passes each request to one of them. It lets you add servers to handle more traffic, take a broken server out without clients noticing, and deploy one server at a time. The policy decides who gets the next request, and health checks decide who may be chosen at all.',
  watch: [
    'Round robin hands out turns and looks at nothing else. Make B slow and B keeps getting every third request, so its connections pile up while A and C sit nearly idle.',
    'Least connections reads the open count of every server and picks the smallest. After the switch in the tour, the slow server is skipped until its pile drains.',
    'Power of two choices reads just two counts, drawn at random, and keeps the smaller. With hundreds of servers that is far cheaper than reading them all, and nearly as even.',
    'Hash by user: h(ana) = 1 + 14 + 1 = 16, and 16 mod 3 = 1, so ana always lands on B. Her second request finds her session cached. The hash ignores load, so if B is slow, ana is stuck with it.',
    'Fail C. The first missed health check is not enough (1 < 2). The second takes C out. Requests that were in flight on C are lost and retried elsewhere.',
    'Add a server under hash by user. Going from 3 servers to 4, h mod n changes for about 3 users in 4, and each of them loses the session cached on their old server.',
    'Fail the balancer. The standby counts missed heartbeats against a limit of 3, then takes over the virtual IP. Clients keep the same address.',
    'This page is small on purpose: one tick between requests, a server is either up, slow (5 times slower) or not answering, a cache holds 3 sessions, and the hash is the sum of the letters.',
  ],
  complexity: [
    { op: 'Round robin', average: 'O(1)', worst: 'O(n)', note: 'One index, moved on each time. The worst case skips over down servers.' },
    { op: 'Weighted round robin (smooth)', average: 'O(n)', worst: 'O(n)', note: 'Add each weight to a running score, take the highest, subtract the total. Each server gets exactly its weight per cycle, spread out.' },
    { op: 'Least connections', average: 'O(n)', worst: 'O(n)', note: 'Reads every count. A heap gets it to O(log n), but counts change on every request and response.' },
    { op: 'Power of two choices', average: 'O(1)', worst: 'O(1)', note: 'Two random reads and one comparison. The maximum load is far lower than with one random pick.' },
    { op: 'Hash by user (mod n)', average: 'O(1)', worst: 'O(n)', note: 'One hash, one mod. Walking past down servers is the worst case. Changing n moves most users.' },
    { op: 'Health checks', average: 'O(n) per interval', worst: 'O(n) per interval', note: 'One probe per server every few seconds, from every balancer. Detection takes interval × threshold.' },
  ],
  space:
    'Small. Per server: an address, a weight, a health state and a connection count. A layer 7 balancer also holds two sockets and some buffer per request in flight, so memory grows with concurrent connections, not with servers. Sticky sessions by cookie need no table; sticky sessions by table need one entry per user.',
  usedIn: [
    {
      name: 'NGINX',
      how: 'A web server and reverse proxy. Its upstream module balances with round robin by default and offers least_conn, ip_hash and a generic hash, with an optional consistent flag (ketama). Its weighted round robin is the smooth version this page animates.',
    },
    {
      name: 'HAProxy',
      how: 'A layer 4 and layer 7 load balancer. Balancing algorithms include roundrobin, leastconn, source and uri hashing. Active health checks use rise and fall counts, which default to 2 and 3, and a server can be put into a drain state for maintenance.',
    },
    {
      name: 'Envoy',
      how: 'The proxy inside the Istio service mesh, among others. Its load balancers include round robin, least request (which by default samples two hosts and takes the less loaded: power of two choices), ring hash and Maglev. It runs active health checks and outlier detection, which ejects hosts that return too many errors.',
    },
    {
      name: 'AWS Application Load Balancer',
      how: 'A managed layer 7 balancer for HTTP and HTTPS. It routes by host and path, terminates TLS, runs health checks per target group, offers sticky sessions with a cookie, and drains a target for a configurable delay before removing it.',
    },
    {
      name: 'AWS Network Load Balancer',
      how: 'A managed layer 4 balancer for TCP and UDP. It does not read HTTP, so it can carry any protocol and keeps very low latency, and it gives a static IP address per availability zone.',
    },
    {
      name: 'keepalived',
      how: 'The usual way to pair two self-run balancers. It speaks VRRP: the active node sends adverts, by default once a second, and the backup claims the virtual IP when they stop.',
    },
  ],
  reachFor: [
    'Any service with more than one server behind one name: web front ends, APIs, internal services.',
    'Rolling deploys: drain one server, update it, put it back, move to the next, with no downtime.',
    'Round robin when requests cost about the same and servers are alike. It is the default for a reason.',
    'Least connections, or power of two choices with many balancers, when request times vary a lot: long polls, uploads, slow queries.',
    'Hashing on a key when a server holds state worth reusing: a cache shard, a session, a WebSocket. Use consistent hashing so a change of pool size moves few keys.',
  ],
  costs: [
    'One more hop on every request, and one more thing to run. A layer 7 proxy adds well under a millisecond on the same network, but it holds every connection open twice.',
    'The balancer is a single point of failure unless it is paired. Active-passive wastes a machine; active-active needs something in front to spread traffic across the balancers.',
    'Least connections from many balancers is only approximate. Each sees only its own connections, and a fresh server with zero can be stampeded by all of them at once.',
    'Sticky sessions fight balancing: a heavy user pins one server, a slow server keeps its users, and losing a server loses its sessions. Store sessions in a shared store, or in a signed cookie, and route freely.',
    'Retries can make an overload worse. Retry only idempotent requests, cap the attempts, and back off.',
    'Health checks see only what they probe. A /health that returns 200 while the database is down keeps a broken server in rotation; one that checks every dependency can take the whole pool out at once.',
  ],
  interview: [
    'Say why it is there: scale out by adding servers, fail over when one dies, and deploy one server at a time. Then say where it sits: DNS points at the balancer, the balancer at the servers.',
    'Layer 4 against layer 7. Layer 4 sees addresses and ports and forwards TCP or UDP: fast, any protocol, but blind to URLs and headers. Layer 7 terminates the connection, often TLS too, and reads the HTTP request: it can route /api and /static to different pools, add headers, retry, and read cookies for stickiness. The price is CPU for TLS and two connections per request.',
    'Name the policies and when each fits. Round robin when requests are alike. Weighted when servers differ in size. Least connections when request times vary. Power of two choices when there are many balancers or servers: two random samples avoid both the herd and the full scan. A hash when the server holds state for that key.',
    'Health checks: active ones probe each server on an interval and need a few failures in a row to take it out, and a few passes to put it back, so one lost packet does not flap it. Passive ones watch real traffic for errors and timeouts, and catch failure sooner. Use both.',
    'Sticky sessions are a smell. Make services stateless, keep sessions in Redis or a signed cookie, and any server can serve any request. Then scaling, failures and deploys lose nothing.',
    'Connection draining: before removing a server, stop sending it new requests and let the in-flight ones finish, up to a timeout. That is how rolling deploys avoid errors.',
    'The balancer itself must not be a single point of failure. Active-passive: a pair shares a floating virtual IP, the standby watches heartbeats (VRRP with keepalived) and claims the IP when they stop. Active-active: several balancers, with DNS returning all of them or one anycast address routed to the nearest.',
    'Global load balancing: DNS answers with the address of the nearest healthy region, by latency or geography. It is coarse, because resolvers cache answers for the TTL, so failover takes at least that long.',
    'Client-side balancing and meshes: the client gets the list of servers from a registry and picks one itself, which saves a hop (gRPC can do this). A service mesh puts a proxy such as Envoy beside every service, so each caller balances, retries and checks health without code changes.',
    'If asked about hashing, mention that mod n moves almost everything when n changes, and that consistent hashing or Maglev hashing moves only about 1/n of the keys.',
  ],
};
