import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A stack lets you add and remove at one end only, the top, so the last item in is the first one out. This one is a plain array plus one number, size, which says how many slots are in use. When the array fills up it is replaced by one twice as large, and that doubling is what keeps the average push cheap.',
  watch: [
    'Push and pop never search. The top item is always at index size - 1 and the first free slot is always at index size.',
    'Every operation starts with one check: is the array full (push), or is the stack empty (pop and peek)?',
    'When a push finds the array full, a new array of twice the size appears below and every item is copied across. Watch the Copies counter jump.',
    'After a doubling, half the new array is free. That many pushes go by with one write each before the next copy, which is why the average cost stays constant.',
    'Popping an empty stack changes nothing. Here it returns nothing; some libraries raise an error instead.',
    'The array never shrinks on this page. Pop clears the slot and lowers size, and the capacity stays where it was.',
  ],
  complexity: [
    { op: 'Push', average: 'O(1) amortised', worst: 'O(n)', note: 'One check and one write. A push that finds the array full first copies all n items into an array twice the size.' },
    { op: 'Pop', average: 'O(1)', worst: 'O(1)', note: 'One check, one read at index size - 1, then the slot is cleared.' },
    { op: 'Peek', average: 'O(1)', worst: 'O(1)', note: 'One check and one read. Nothing is written.' },
    { op: 'n pushes from empty', average: 'O(n) in total', worst: 'O(n) in total', note: 'The copies add up to 4 + 8 + 16 and so on, which is always less than 2n. So n pushes cost fewer than 3n writes.' },
    { op: 'Find a value', average: 'O(n)', worst: 'O(n)', note: 'A stack is not built for searching. Only the top is in reach.' },
  ],
  space: 'O(n). Straight after a doubling the array is half empty, so it can use about twice the space of its items. This version never gives memory back.',
  usedIn: [
    {
      name: 'The call stack',
      how: 'Every thread has one. Calling a function pushes a frame holding its local variables and return address, and returning pops it. Recursion that goes too deep runs out of room: a stack overflow.',
    },
    {
      name: 'Go goroutine stacks',
      how: 'A goroutine starts with a stack of a few kilobytes. When it fills, the runtime allocates one twice the size and copies the old stack into it, the same doubling this page shows.',
    },
    {
      name: 'Bytecode virtual machines',
      how: 'The JVM, CPython and WebAssembly are stack machines. An instruction pops its operands from an operand stack and pushes its result back.',
    },
    {
      name: 'HTML parsers',
      how: 'The HTML standard has the parser keep a "stack of open elements". A start tag pushes an element and the matching end tag pops it, which is how the parser knows what is nested in what.',
    },
    {
      name: 'Undo in editors',
      how: 'Each edit is pushed onto an undo stack. Undo pops the latest edit and pushes it onto a redo stack, so the most recent change is always the first to be reversed.',
    },
    {
      name: 'Java ArrayDeque and Python list',
      how: 'The standard stacks in both languages are growable arrays. The Java documentation says to prefer ArrayDeque to the old Stack class, and the Python tutorial uses list.append and list.pop.',
    },
    {
      name: 'Depth-first search',
      how: 'A stack of nodes still to visit drives the search: pop one, push its unvisited neighbours. Tracing garbage collectors walk the object graph the same way with a mark stack.',
    },
  ],
  reachFor: [
    'The newest item is the one you need next: undo, backtracking, matching brackets, nested function calls.',
    'Turning recursion into a loop. An explicit stack on the heap can grow far past the limit of the call stack.',
    'Depth-first traversal of a tree or graph, or evaluating an expression as a parser reads it.',
    'You want the cheapest possible container. An array-backed stack is one block of memory and one integer.',
  ],
  costs: [
    'Only the top is in reach. Reading or removing anything lower means popping what is above it.',
    'Most pushes are one write, but the one that triggers a doubling copies everything. That pause matters where each operation has a deadline, such as audio or a trading system.',
    'The array is up to half empty after a doubling, and this version never shrinks. A stack that grew large once keeps that memory.',
    'Growing by a fixed number of slots looks thriftier but is far worse: n pushes then cost about n squared writes in total, not about 3n.',
    'Last in, first out is unfair to old items. Under steady load the item at the bottom may wait for ever, so do not use a stack where order of arrival matters.',
  ],
  interview: [
    'Explain amortised O(1) with the sum. "By the time n items have been pushed, the copies add up to 4 + 8 + 16 and so on, which is less than 2n. Add the n writes for the pushes themselves and the total is under 3n, so each push is O(1) on average even though one in a while is O(n)."',
    'Say why the growth must be by a factor. Any constant factor gives amortised O(1): Java\'s ArrayList grows by half, CPython\'s list by about an eighth. Adding a fixed number of slots gives O(n) per push on average.',
    'Amortised is not worst case. If one slow push is unacceptable, size the array up front, or use a linked stack: each push allocates a node, so it costs more on average but never copies.',
    'To shrink safely, halve the array only when it is a quarter full. Halving at half full lets a push and a pop at the boundary copy the whole array every time.',
    'Deep recursion on untrusted input can overflow the call stack. The default is often about 8 MB for a Linux main thread and 1 MB for a JVM thread. Move the work to an explicit stack on the heap.',
    'A stack shared between threads needs a lock or a lock-free design. The classic one is the Treiber stack: a linked list whose head is swapped with compare-and-swap, with care needed over the ABA problem.',
    'Last in, first out can be the right queueing policy under overload. Facebook described serving the newest requests first when a queue backs up, because the oldest callers have probably given up already.',
  ],
};
