import type { Practice } from '../types';

const page: Practice = {
  id: 'tic-tac-toe',
  title: 'Tic-tac-toe',
  summary:
    'Build tic-tac-toe for two players as one class: legal moves on a 3 by 3 board, then a status that says X has won, O has won, a draw or still in progress.',
  minutes: 25,
  core: 2,
  testing: {
    intro:
      'This is the easy task of the set: 60 lines of your own by the end of stage 2, for a game everyone knows. With code that short, what the two people watching have to go on is how you work.',
    points: [
      'You ask what a bad move does and what "who has won" returns mid-game, and state an assumption for each, before you type a signature.',
      'You agree a small API (`move`, `cell`, `turn`, `status`) and test only through it, so that replacing the win check in stage 4 changes no test.',
      'You say each decision as you make it: the size in a field `n`, check before write, win before draw.',
    ],
  },
  use: 'Drill "Ask first" and stages 1 and 2 until you can type them in 25 minutes while talking. Stages 3 to 5 and the last ten minutes are things to say, not to code up front.',
  brief: [
    '"Implement tic-tac-toe for two players. I should be able to make moves and ask who has won."',
  ],
  given: [
    '`enum Player { X, O }` and `enum Status { IN_PROGRESS, X_WINS, O_WINS, DRAW }`: use them as they are.',
    'A `Game` class with both constructors and all six methods stubbed; no stage changes a signature. From an empty file, write those stubs first and read them aloud.',
    'Rows and columns count from 0, `cell` returns `null` for an empty cell, and `toString` prints one line a row with `X`, `O` or `.`.',
    'Test helpers: `play(game, r, c, ...)` plays the pairs in turn; `thrown(() -> ...)` names the exception thrown, or `nothing`.',
    'The tests of all five stages: set `STAGE` and run `main`. Untouched, all six stage 1 tests fail.',
  ],
  ask: [
    {
      q: 'How should I report a bad move: an exception, or a return value?',
      why: 'It shapes every signature and every test: with exceptions `move` returns nothing and a mistake is loud.',
      assume:
        'Exceptions with a message: `IllegalArgumentException` for a cell off the board or taken, `IllegalStateException` when no move is allowed at all.',
    },
    {
      q: 'What does "who has won" return while the game is still going, and is a draw a result?',
      why: 'There are four answers, and a player or `null` cannot tell a draw from a game in progress, so this decides the return type of `status`.',
      assume: 'One `Status` with four values. A draw is a full board with no line.',
    },
    {
      q: 'Is the board always 3 by 3?',
      why: 'Writing `n` from the first line costs nothing; taking 3 out of finished code means reading every loop again.',
      assume: '3 by 3 for now, with the size in one field.',
    },
    {
      q: 'Who moves first, and does the game keep track of whose turn it is?',
      why: 'If the game owns the turn, `move` takes only a row and a column and nobody can play out of turn. A player passed in is one more bad move to reject and test.',
      assume: 'X first, always, and the game alternates. `turn()` says who is next.',
    },
    {
      q: 'Do you want any input or display: a console loop, a screen?',
      why: 'A console loop reads, parses and prints: none of it is in the brief, no test can run it, and it spends the minutes stage 2 needs.',
      assume: 'No. One class with methods and tests. Display stays outside it and reads cells; `toString` is only for debugging.',
    },
  ],
  outline: `new game of size n (3 unless told):
  refuse a size below 1
  an empty n by n board; X to move; in progress
  a count for each row, each column and the two diagonals
  an empty history

move(row, col):
  refuse if the game is over
  refuse if the cell is off the board
  refuse if the cell is taken
  put the mover's mark in the cell
  add +1 for X or -1 for O to the cell's row and column,
    and to each diagonal the cell lies on
  count the move; remember the cell in the history
  if a count through the cell is +n or -n: the mover has won
  otherwise, if every cell is full: a draw
  pass the turn

undo:
  refuse if the history is empty
  take the newest cell off the history; note whose mark it is
  clear the cell; take that mark back out of the counts
  one move fewer; that player to move; in progress

cell(row, col): refuse if off the board; the mark, or nothing
status: the stored answer`,
  parts: [
    {
      id: 'board',
      title: 'A board and legal moves',
      stage: 1,
      ask: 'A 3 by 3 board. X moves first, then the players take turns. Reject a move off the board or onto a taken cell, and say why. Let me read any cell, and print the board.',
      tests: [
        'new game is empty and x moves first',
        'a move marks the cell and passes the turn',
        'players take turns',
        'a move off the board is rejected',
        'a move on a taken cell is rejected',
        'the board prints row by row',
      ],
      regions: ['board', 'move', 'read', 'print'],
      pseudocode: `a game holds:
  n = 3
  an n by n grid, every cell empty
  turn = X

move(row, col):
  if row or col is outside 0 to n - 1: refuse, "off the board"
  if the cell is taken: refuse, "cell taken"
  put turn's mark in the cell
  turn = the other player

cell(row, col):
  if row or col is outside 0 to n - 1: refuse, "off the board"
  answer the mark in the cell, or nothing

turn(): answer turn

print:
  one line for each row: X, O or . for each cell`,
      choice:
        'Keep the board as a `Player[][]` with `null` for an empty cell, and the size in a field `n`, set to 3 in one place. An `EMPTY` constant would change supplied code and put a non-player into the type `turn()` returns. `move` checks first and writes last, so a refused move changes nothing. The bounds test is `row < 0 || row >= n`: `>=`, because row `n` is one past the last. Put it in `requireOnBoard` so that `cell` shares it.',
      say: "I'll keep the board as a grid of the Player enum with null for empty, and move checks everything before it writes, so a rejected move changes nothing.",
      trace: {
        caption: 'A refused call changes nothing: the turn stays with O through three refusals, and so does the board.',
        head: ['Call', 'Turn after', 'Board', 'Result'],
        rows: [
          ['new Game()', 'X', '`.../.../...`', 'ok'],
          ['move(0, 0)', 'O', '`X../.../...`', 'ok'],
          ['move(0, 0)', 'O', '`X../.../...`', 'IllegalArgumentException: cell taken: 0, 0'],
          ['move(3, 0)', 'O', '`X../.../...`', 'IllegalArgumentException: off the board: 3, 0'],
          ['cell(3, 0)', 'O', '`X../.../...`', 'IllegalArgumentException: off the board: 3, 0'],
          ['move(1, 1)', 'X', '`X../.O./...`', 'ok'],
          ['move(2, 2)', 'O', '`X../.O./..X`', 'ok'],
        ],
        note: 'The board is written with `/` between rows. Rows 3 and 4 are the calls in the two rejection tests.',
      },
      pitfalls: [
        'Passing the turn before the checks: a rejected move skips a player, and "a move on a taken cell is rejected" fails with `expected O, got X`.',
        'Writing `>` for `>=`: `move(3, 0)` reaches the array, and the test gets `ArrayIndexOutOfBoundsException` where it expects `IllegalArgumentException`.',
        'Leaving `toString` until last: you stare at a failing test when `System.out.println(game)` would show the board at once.',
      ],
    },
    {
      id: 'winner',
      title: 'Who has won',
      stage: 2,
      ask: 'Tell me where the game stands: X has won, O has won, a draw, or still in progress. A full row, column or diagonal wins. A full board with no line is a draw. Nobody may move once the game is over.',
      tests: [
        'a full row wins for x',
        'a full column wins for o',
        'either diagonal wins',
        'a full board with no line is a draw',
        'a win on the last cell is not a draw',
        'no move is allowed once the game is over',
      ],
      regions: ['status-fields', 'move', 'outcome', 'status'],
      pseudocode: `a game also holds:
  status = in progress
  moves = 0

move(row, col):
  if status is not in progress: refuse, "game is over"
  the two checks from stage 1
  put turn's mark in the cell
  moves = moves + 1
  status = outcome(row, col)
  turn = the other player

outcome(row, col):
  if the mover holds a whole line through this cell:
    answer that the mover has won
  if moves equals n times n: answer draw
  answer in progress

the mover holds a whole line through (row, col) if it holds:
  the cell's row, or the cell's column,
  or the main diagonal, when row equals col,
  or the other diagonal, when row plus col equals n - 1
  (one pass over i from 0 to n - 1 checks all four)

status(): answer status`,
      choice:
        'Work the result out once, inside `move`, and store it: `status()` returns the field, and the game-over guard is one comparison, `status != Status.IN_PROGRESS`, ahead of every other check. Scan only the lines through the cell just played, since no other line can have just been completed; a typed table of eight lines is the first thing stage 3 breaks. One loop of `n` does it, with `&=` keeping each flag true only while every cell matches. **Win before draw**: the ninth move can do both, so `moves == n * n` is tested only when there was no win.',
      say: "I'll work the result out once a move and store it, and I check win before draw because the last move can be both.",
      trace: {
        caption: 'The status changes on the move that completes the row. After that `move` refuses before it looks at the cell: (2, 2) is free and on the board.',
        head: ['Call', 'Turn after', 'Board', 'Moves', 'Status', 'Result'],
        rows: [
          ['new Game()', 'X', '`.../.../...`', '0', 'IN_PROGRESS', 'ok'],
          ['move(0, 0)', 'O', '`X../.../...`', '1', 'IN_PROGRESS', 'ok'],
          ['move(1, 0)', 'X', '`X../O../...`', '2', 'IN_PROGRESS', 'ok'],
          ['move(0, 1)', 'O', '`XX./O../...`', '3', 'IN_PROGRESS', 'ok'],
          ['move(1, 1)', 'X', '`XX./OO./...`', '4', 'IN_PROGRESS', 'ok'],
          ['move(0, 2)', 'O', '`XXX/OO./...`', '5', 'X_WINS', 'ok'],
          ['move(2, 2)', 'O', '`XXX/OO./...`', '5', 'X_WINS', 'IllegalStateException: game is over: X_WINS'],
        ],
        note: 'The first six rows are the test "a full row wins for x".',
      },
      pitfalls: [
        'Writing the anti-diagonal cell as `board[i][n - i]`, not `n - 1 - i`: the first move of every game throws `ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 3`.',
        'Passing the turn before calling `outcome`: the scan looks for the other player\'s marks, and "a full row wins for x" fails with `expected X_WINS, got IN_PROGRESS`.',
        'Reaching for the counters now: the scan is short and plainly right, and its tests are what make the counters safe to add later.',
      ],
    },
    {
      id: 'any-size',
      title: 'Any size',
      stage: 3,
      ask: 'Play on any n by n board, where a full line of n wins. `new Game()` is still 3 by 3. Refuse a board smaller than 1 by 1.',
      tests: [
        'four by four needs four in a row',
        'four by four reaches every cell and no further',
        'four by four can end in a draw',
        'on one by one the first move wins',
        'a board smaller than one by one is refused',
      ],
      regions: ['constructors'],
      pseudocode: `new game with no size given:
  a new game of size 3

new game of size n:
  if n is less than 1: refuse, "board size must be at least 1"
  keep n
  an n by n grid, every cell empty

everything else stays as it is: it already reads n`,
      verbal: [
        'The size is already a field, so this only touches the two constructors.',
        'The default one hands over to the sized one with 3, and the sized one refuses anything below 1.',
        'Everything else already reads `n`, so the earlier tests should pass unchanged.',
      ],
      choice:
        'Chain the constructors: `Game()` is `this(3)`, so the default is written once and the size check covers both. Refuse `n < 1`: on a 0 by 0 board every move is off the board and `moves == n * n` is true before anyone has played. Size 1 is allowed and is a real edge: the first move fills the board and completes a line, and since the win is tested first the answer is `X_WINS`. Write `this.n = n`, as the parameter hides the field; `n = n` does not compile.',
      say: "I'm making the no-argument constructor delegate with 3, then running everything: the 4 by 4 tests would find a 3 I left behind.",
      trace: {
        caption: 'Three in a row is not a win on 4 by 4: the game is still in progress after `move(0, 2)` and ends only when the fourth X lands.',
        head: ['Call', 'Turn after', 'Board', 'Status'],
        rows: [
          ['new Game(4)', 'X', '`..../..../..../....`', 'IN_PROGRESS'],
          ['move(0, 0)', 'O', '`X.../..../..../....`', 'IN_PROGRESS'],
          ['move(1, 0)', 'X', '`X.../O.../..../....`', 'IN_PROGRESS'],
          ['move(0, 1)', 'O', '`XX../O.../..../....`', 'IN_PROGRESS'],
          ['move(1, 1)', 'X', '`XX../OO../..../....`', 'IN_PROGRESS'],
          ['move(0, 2)', 'O', '`XXX./OO../..../....`', 'IN_PROGRESS'],
          ['move(1, 2)', 'X', '`XXX./OOO./..../....`', 'IN_PROGRESS'],
          ['move(0, 3)', 'O', '`XXXX/OOO./..../....`', 'X_WINS'],
        ],
        note: 'The test "four by four needs four in a row". On the same file `new Game(0)` throws `IllegalArgumentException: board size must be at least 1, got 0`, and the first move of `new Game(1)` gives `X_WINS`.',
      },
      pitfalls: [
        'A 3 left in a loop or a bound: all twelve earlier tests pass and the 4 by 4 tests fail, with `off the board: 0, 3` or a game that ends after three in a row.',
        'Leaving `Game()` to build its own grid: the next field you add gets set in one constructor and forgotten in the other.',
      ],
    },
    {
      id: 'counters',
      title: 'A win check in constant time',
      stage: 4,
      ask: 'Boards may be large. Make the win check after each move take the same time however big the board is. Every earlier test must still pass without changing it.',
      tests: [
        'the centre counts for both diagonals',
        'the anti-diagonal wins on an even board',
        'a row of mixed marks is not a win',
        'a long row wins on a 50 by 50 board',
      ],
      regions: ['line-counts', 'sized-constructor', 'move', 'count', 'wins'],
      pseudocode: `a game also holds, all starting at 0:
  a count for each row
  a count for each column
  a count for the main diagonal
  a count for the other diagonal

weight of a player: +1 for X, -1 for O

count(row, col, d):
  add d to this row's count
  add d to this column's count
  if row equals col: add d to the main diagonal's count
  if row plus col equals n - 1: add d to the other one's

move(row, col):
  the three checks, then place the mark, as before
  count(row, col, the mover's weight)
  then moves, outcome and the turn, as before

the mover holds a whole line through (row, col) if:
  this row's count is n or -n
  or this column's count is n or -n
  or the cell is on the main diagonal and its count is n or -n
  or the cell is on the other one and its count is n or -n`,
      verbal: [
        "I'd keep a count for each row, each column and the two diagonals: plus 1 for X, minus 1 for O.",
        'A line has `n` cells, so the mover has won when a count through the cell just played reaches plus or minus `n`.',
        "That's four comparisons a move on any board, for `2n + 2` extra integers, and no public method changes.",
      ],
      choice:
        'Stop reading the board to find a win. Keep an `int` for each line and `wins` becomes four comparisons such as `Math.abs(rows[row]) == n`, where `abs` covers both players. Update the diagonals with two separate `if`s, never `else if`: the centre of an odd board is on both. **Not one earlier test had to change.** The 17 tests of stages 1 to 3 pass as written, because they only call the public methods: that is what agreeing the API first bought you. The counts work only for `n` in a row on an `n` by `n` board, so say so before you are asked.',
      say: "I'm adding the counts beside the scan and running the tests first, then swapping the body of wins, so anything red is in the lines I've just typed.",
      trace: {
        caption: 'The centre move adds 1 to both diagonals. O at (0, 0) cancels the main diagonal back to 0, and the anti-diagonal climbs 1, 2, 3 until it equals `n`.',
        head: ['Call', 'Board', 'rows', 'cols', 'diag', 'anti', 'Status'],
        rows: [
          ['new Game()', '`.../.../...`', '`[0, 0, 0]`', '`[0, 0, 0]`', '0', '0', 'IN_PROGRESS'],
          ['move(1, 1)', '`.../.X./...`', '`[0, 1, 0]`', '`[0, 1, 0]`', '1', '1', 'IN_PROGRESS'],
          ['move(0, 0)', '`O../.X./...`', '`[-1, 1, 0]`', '`[-1, 1, 0]`', '0', '1', 'IN_PROGRESS'],
          ['move(2, 0)', '`O../.X./X..`', '`[-1, 1, 1]`', '`[0, 1, 0]`', '0', '2', 'IN_PROGRESS'],
          ['move(1, 0)', '`O../OX./X..`', '`[-1, 0, 1]`', '`[-1, 1, 0]`', '0', '2', 'IN_PROGRESS'],
          ['move(0, 2)', '`O.X/OX./X..`', '`[0, 0, 1]`', '`[-1, 1, 1]`', '0', '3', 'X_WINS'],
        ],
        note: 'The test "the centre counts for both diagonals". `diag` and `anti` are the fields `diagonal` and `antiDiagonal`.',
      },
      pitfalls: [
        'Giving both players `+1`: a row of X, O, X counts 3 and reads as a win, and "a row of mixed marks is not a win" fails.',
        'Writing the test in `count` as `row + col == n`: the anti-diagonal count can never reach `n`, and "the anti-diagonal wins on an even board" fails.',
        'Deleting the board because the counts seem to hold everything: `cell`, the taken-cell check and `toString` still read it.',
      ],
      caveat:
        'The four stage 4 tests also pass on the stage 3 scan, and none measures time: that the check is constant is read off the code.',
    },
    {
      id: 'undo',
      title: 'Undo',
      stage: 5,
      ask: 'Let players take moves back. `undo` removes the last move; calling it again removes the one before. After an undo the game is exactly as it was before that move, even if the move won.',
      tests: [
        'undo on a new game is refused',
        'undo takes back the last move and the turn',
        'undo twice takes back two moves',
        'undoing a win puts the game back in progress',
        'after undoing a win a different move counts',
        'replaying an undone win wins again',
      ],
      regions: ['history', 'move', 'undo'],
      pseudocode: `a game also holds:
  history: a stack of cells, newest on top

move(row, col):
  as before, and once the mark is placed:
  push (row, col) onto history

undo():
  if history is empty: refuse, "no moves to undo"
  take the top cell off history
  player = the mark in that cell
  clear the cell
  count(that row, that col, minus the player's weight)
  moves = moves - 1
  turn = player
  status = in progress`,
      verbal: [
        "I'd keep a stack of the cells played: `move` pushes one and `undo` pops one.",
        '`undo` clears the cell, takes that mark back out of the counts, drops the move count and hands the turn back.',
        'The status goes back to in progress, because no move is allowed once the game is over.',
      ],
      choice:
        'Remember the moves, not the boards: a stack of cells costs one small record a move, where a copy of the board costs `n × n` cells. Use an `ArrayDeque` through `push` and `pop`, and a `record Cell(int row, int col)`, one line that gives you `row()` and `col()`. `undo` must put back **five** things: the cell, the counts, `moves`, the turn and the status. `count` takes a signed `delta` so that it can take a mark out. Undo on a new game throws `IllegalStateException`: the call is well formed and the timing is wrong.',
      say: "I'm going down move and reversing each line, and I read the player back from the board before clearing the cell, because turn has already passed on.",
      trace: {
        caption: 'The undo puts every value back to the row above the winning move: row 0 from 3 to 2, the anti-diagonal from 0 to -1, the history from 5 to 4, the turn to X.',
        head: ['Call', 'Turn after', 'Board', 'rows', 'diag', 'anti', 'History', 'Status', 'Result'],
        rows: [
          ['new Game()', 'X', '`.../.../...`', '`[0, 0, 0]`', '0', '0', '0', 'IN_PROGRESS', 'ok'],
          ['undo()', 'X', '`.../.../...`', '`[0, 0, 0]`', '0', '0', '0', 'IN_PROGRESS', 'IllegalStateException: no moves to undo'],
          ['move(0, 0)', 'O', '`X../.../...`', '`[1, 0, 0]`', '1', '0', '1', 'IN_PROGRESS', 'ok'],
          ['move(1, 0)', 'X', '`X../O../...`', '`[1, -1, 0]`', '1', '0', '2', 'IN_PROGRESS', 'ok'],
          ['move(0, 1)', 'O', '`XX./O../...`', '`[2, -1, 0]`', '1', '0', '3', 'IN_PROGRESS', 'ok'],
          ['move(1, 1)', 'X', '`XX./OO./...`', '`[2, -2, 0]`', '0', '-1', '4', 'IN_PROGRESS', 'ok'],
          ['move(0, 2)', 'O', '`XXX/OO./...`', '`[3, -2, 0]`', '0', '0', '5', 'X_WINS', 'ok'],
          ['undo()', 'X', '`XX./OO./...`', '`[2, -2, 0]`', '0', '-1', '4', 'IN_PROGRESS', 'ok'],
          ['move(0, 2)', 'O', '`XXX/OO./...`', '`[3, -2, 0]`', '0', '0', '5', 'X_WINS', 'ok'],
        ],
        note: 'From row 3 on, the test "replaying an undone win wins again". `History` is the size of the stack.',
      },
      pitfalls: [
        'Restoring the cell and forgetting one of the other four: without the turn four tests fail, without the status three, and without the counts only "replaying an undone win wins again".',
        'Taking the player from `turn`: the weight has the wrong sign, and "replaying an undone win wins again" reports `O_WINS`.',
        'Filling the deque with `add` and emptying it with `pop`: `add` goes on the tail and `pop` takes the head, so undo removes the first move of the game.',
      ],
    },
  ],
  followUps: [
    {
      q: 'Why exceptions, and not a boolean from `move`?',
      a: "I'd keep exceptions: a bad move is the caller's mistake, and a boolean is easy to ignore and can't say which rule was broken. The cost is that a screen must check `cell` and `status` first, or catch two exception types.",
    },
    {
      q: 'What does `turn()` return once the game is over?',
      a: "It still names the player who would have been next: O after X's winning move, and no test covers it. I'd ask what you want, because a screen will show it; returning `null` or throwing is more honest and changes one method.",
    },
    {
      q: 'What does this leave out, and what would you change in review?',
      a: "It has no game ids, no player identities, nothing saved and no redo, and X always moves first. In review I'd drop the `moves` field, which by stage 5 always equals `history.size()`, and ask whether the API wants a cell type in place of two plain `int`s.",
    },
    {
      q: 'How would you test it more thoroughly?',
      a: "A table first: for each board size, each of the `2n + 2` lines and each player, play that line and expect a win. Then random legal games, checking that there is never a second winner and that a move then `undo` changes nothing, with the stage 3 scan run beside the counters.",
    },
    {
      q: 'Is this class safe to call from two threads?',
      a: "No: two threads in `move` can both pass the taken-cell check, and updates to the turn and the counts can be lost. `synchronized` on the public methods is enough: that is one lock for each game, and games are independent and moves are rare.",
    },
    {
      q: 'What changes for five in a row on a 15 by 15 board, or for connect four?',
      a: "The counters go, because a count can't see whether five marks are next to each other. From the last move I'd walk outwards in four directions, both ways, counting the mover's marks, so the work grows with k and not with the board. Connect four adds gravity: `move(col)` drops the mark to the lowest free row.",
    },
    {
      q: 'How would you add a computer player?',
      a: "On 3 by 3, plain minimax: try every legal move, score where it leads, and pick the best assuming the opponent does the same. The tree is small enough to search to the end, and `undo` makes it cheap: try a move, recurse, take it back. Bigger boards need alpha-beta pruning and a depth limit.",
    },
    {
      q: 'What if the board were a billion by a billion, with five in a row to win?',
      a: "I wouldn't allocate the grid or the counts: a map from cell to player holds only the occupied cells, and the same walk from the last move uses map lookups. A draw by a full board stops meaning anything, so I'd ask for another rule to end the game.",
    },
    {
      q: 'How would you keep games in a database?',
      a: "A `games` row with the size, the players and the status, and an append-only `moves` table with a unique key on game id and move number. That key stops two writers both making move 7, and replaying the table rebuilds the board and gives me undo.",
    },
    {
      q: 'How would two people play over a network?',
      a: "The server owns the game; clients send moves and draw what it tells them. Each move carries its move number and is applied only if that number is next, so a retry does no harm and two clicks at once can't both land: the same idea as an [idempotency key](#/s/idempotency-keys). The other player hears by WebSocket or long polling.",
    },
  ],
  see: [
    { href: '#/s/stack', label: 'Stack' },
    { href: '#/s/hash-table', label: 'Hash table' },
    { href: '#/s/idempotency-keys', label: 'Idempotency keys' },
  ],
  unverified: [
    'That minimax can search 3 by 3 to the end, and that alpha-beta pruning and a depth limit are the next steps: general knowledge, not run here.',
    'The network answer (move numbers, WebSocket or long polling) and the database answer (an append-only moves table with a unique key): common designs from memory; none was built.',
    'The table tests, random-game checks and comparison against the scan in the testing answer were not written or run.',
    'That `synchronized` on the public methods is enough for two threads was reasoned from the code, not tested with threads.',
    'The outward walk for k in a row and the map for a huge board were not written or run.',
    "That an easy task shows how a candidate works, and that the talking is what the people watching have to go on, is this page's judgement, not checked against a source.",
  ],
};

export default page;
