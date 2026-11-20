import type { Practice } from '../types';

const page: Practice = {
  id: 'tic-tac-toe',
  title: 'Tic-tac-toe',
  summary:
    'Build tic-tac-toe for two players as one class: legal moves first, then who has won. It is the easy task of the set, so it shows how you work: the questions you ask, the API you agree and what you say while you type.',
  minutes: 25,
  core: 2,
  brief: [
    '"Implement tic-tac-toe for two players. I should be able to make moves and ask who has won."',
    'That is the whole brief. It leaves out the board size, what a bad move does and what "who has won" returns before the end. Ask before you type.',
  ],
  given: [
    '`enum Player { X, O }` and `enum Status { IN_PROGRESS, X_WINS, O_WINS, DRAW }`. They are supplied code: use them as they are and add nothing to them.',
    'An empty `Game` class with every method the tests call already stubbed: `Game()`, `Game(int n)`, `move(row, col)`, `cell(row, col)`, `turn()`, `status()`, `undo()` and `toString()`. Most stubs throw `UnsupportedOperationException` naming their stage. No later stage changes a signature.',
    'The conventions the tests rely on: rows and columns count from 0, `cell` returns `null` for an empty cell, and `toString` gives one line for each row with `X`, `O` or `.` for each cell.',
    'Two test helpers. `play(game, r, c, r, c, ...)` plays row and column pairs in turn and returns the game. `thrown(() -> ...)` returns the simple class name of the exception a call throws, or `nothing`.',
    'A test harness and the tests of all five stages. Set `STAGE` and run `main`. With the starter untouched, all six stage 1 tests fail and nothing crashes.',
    'If you ever start from an empty file, write those eight signatures first, as stubs, and read them aloud. That list is the API you are agreeing with the two people watching.',
  ],
  ask: [
    {
      q: 'How should I report a bad move: an exception, or a return value?',
      why: 'It shapes every signature and every test. With exceptions `move` returns nothing and a mistake is loud. With a boolean the caller can ignore the answer, and never learns whether the cell was taken or off the board.',
      assume:
        'Exceptions with a message. `IllegalArgumentException` when the cell is wrong (off the board, or taken) and `IllegalStateException` when no move is allowed at all. A caller who wants no exceptions can check `cell` and `status` first.',
    },
    {
      q: 'What should "who has won" return while the game is still going, and is a draw a result?',
      why: 'It sounds as if it returns a player, but there are four answers. A player or `null` cannot tell a draw from a game still in progress, so the answer decides the return type of `status`.',
      assume: 'One `Status` with four values: in progress, X wins, O wins, draw. A draw is a full board with no line.',
    },
    {
      q: 'Is the board always 3 by 3?',
      why: 'If it might grow, 3 has to be a field and the win check cannot be a typed table of eight lines. Writing `n` from the first line costs nothing. Taking 3 out of finished code means reading every loop again.',
      assume: '3 by 3 for now, with the size held in one field so that nothing else depends on the number 3.',
    },
    {
      q: 'Can anyone move once the game is over?',
      why: 'If they can, a second line can be completed and there are two winners. If they cannot, `move` needs a guard ahead of every other check, and that guard is one comparison when the status is stored.',
      assume: 'No. A move after the end throws `IllegalStateException`, even onto a free cell.',
    },
    {
      q: 'Who moves first, and does the game keep track of whose turn it is?',
      why: 'If the game owns the turn, `move` takes a row and a column and nobody can play out of turn. If the caller passes the player, there is one more kind of bad move to reject and to test.',
      assume: 'X first, always, and the game alternates. `turn()` says who is next.',
    },
    {
      q: 'Do you want any input or display: a console loop, a screen?',
      why: 'A console loop reads input, parses it and prints. None of that is in the brief and no test can run it. Asking also lets you say where display would go.',
      assume: 'No. A class with methods and tests. `toString` prints the board for debugging and nothing else does display.',
    },
    {
      q: 'Do rows and columns count from 0 or from 1?',
      why: 'It sets the bounds check and every coordinate in every test. With 1-based input each array index needs a `- 1`, and a forgotten one shows only on the last row or column.',
      assume: 'From 0, row first, then column. A display can add 1.',
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
      regions: ['board', 'move', 'read', 'print'],
      explain: [
        'The board is a `Player[][]` with `null` for an empty cell. That uses the supplied enum as it stands. The obvious alternative, an `EMPTY` constant in `Player`, changes supplied code and puts a value that is not a player into the type `turn()` returns. A `char[][]` works too, but then `cell` has to translate back to `Player`.',
        'The size is a field, `n`, set to 3 in one place. Every bound and every loop reads `n`. That one habit is what makes stage 3 a change to the constructors and nothing else.',
        '`move` checks, then changes. It tests that the cell is on the board, then that it is free, and only then writes the mark and passes the turn. A rejected move leaves the board and the turn exactly as they were, and two tests read the turn after a rejection. A move is two checks and two writes whatever the size; the grid is `n × n` references, 9 here.',
        'The bounds check is its own method, `requireOnBoard`, because `cell` needs it too. Without it `cell(3, 0)` throws `ArrayIndexOutOfBoundsException`, which tells the caller about your array and not about their mistake. With it they read `off the board: 3, 0`.',
        'Type it in this order: the three fields and the constructor, then `cell`, `turn` and `toString`. The first test passes at that point, before `move` exists, and from then on you can print the board whenever a test surprises you.',
      ],
      lines: [
        { code: 'n = 3;', note: 'The only 3 in the class. Everything below reads `n`.' },
        {
          code: 'if (row < 0 || row >= n || col < 0 || col >= n) {',
          note: '`>=`, not `>`: row `n` is one past the last row. With `row > n` the call `move(3, 0)` reaches the array, and the test reports `ArrayIndexOutOfBoundsException` where it expects `IllegalArgumentException`.',
        },
        {
          code: 'turn = turn == Player.X ? Player.O : Player.X;',
          note: 'The only place the turn passes. It is the last line of `move`, so it runs only when the move was legal.',
        },
        {
          code: 'out.append(board[r][c] == null ? "." : board[r][c]);',
          note: 'Appending an enum constant to a `StringBuilder` appends its name, so this writes `X` or `O` with no `switch`.',
        },
      ],
      trace: {
        caption: 'A refused call changes nothing: the turn stays with O through three refusals, and the board is the same after each as before it.',
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
        note: 'The board is written with `/` between rows. Rows 3 and 4 are the calls in the tests "a move on a taken cell is rejected" and "a move off the board is rejected". `cell(3, 0)` goes through the same check as `move`.',
      },
      say: "I'll keep the board as a grid of the Player enum with null for empty, and hold the size in a field so nothing depends on 3. In move I check everything first and only then write, so a rejected move changes nothing.",
      pitfalls: [
        'Passing the turn before the checks: a rejected move then skips a player, and "a move on a taken cell is rejected" fails with `expected O, got X`.',
        'Writing `>` for `>=` in the bounds check, or leaving the check out: row 3 reaches the array and the caller sees `ArrayIndexOutOfBoundsException`.',
        'Typing 3 into a loop or a bound: every test of stages 1 and 2 still passes, and the mistake shows only when stage 3 asks for 4 by 4.',
        'Writing a console loop that reads moves: nobody asked for it, no test runs it, and it spends the minutes stage 2 needs.',
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
      regions: ['status-fields', 'move', 'outcome', 'status'],
      explain: [
        'Work the result out once, inside `move`, and store it. `status()` returns the field. The obvious alternative is to scan the board every time someone calls `status()`. Storing it makes the game-over guard one comparison at the top of `move`, and `status()` costs the same however often it is asked.',
        'Check only the lines through the cell just played: its row, its column, and a diagonal when the cell is on one. No other line can have been completed by this move, and a line completed earlier would already have ended the game. Checking all eight lines is also correct, but on 3 by 3 it tends to become a typed table of eight triples, and that table is the first thing stage 3 breaks.',
        '**Win before draw.** The ninth move fills the board whether or not it completes a line, so the draw test must be reached only when there was no win. Count the marks in `moves`, and a full board is `moves == n * n` with no search for an empty cell.',
        '`outcome` runs after the mark is placed and before the turn passes, so inside it `turn` is still the player who just moved. That is why the scan compares cells with `turn` and the win is credited to `turn`. Leave a one-line comment saying so, because the order is easy to break later.',
        'Type the two fields, then `outcome` and `wins`, then the additions to `move`: the guard, `moves++` and the call to `outcome`. Nothing from stage 1 is rewritten. The cost is one loop of `n` for each move: 3 steps here, each reading 4 cells.',
      ],
      lines: [
        {
          code: 'if (status != Status.IN_PROGRESS) {',
          note: 'The first check in `move`, ahead of the bounds check. A move after the end is refused with `IllegalStateException` even onto a free cell on the board.',
        },
        {
          code: 'boolean antiDiagonal = row + col == n - 1;',
          note: 'On 3 by 3 the anti-diagonal is (0, 2), (1, 1), (2, 0): the coordinates add up to 2, which is `n - 1`. A cell off that diagonal starts `false`, and `&=` can never turn `false` back to `true`.',
        },
        {
          code: 'fullRow &= board[row][i] == turn;',
          note: '`&=` on a `boolean` stays `true` only while every cell so far has matched. One loop covers the row, the column and both diagonals. An empty cell is `null`, which never equals `turn`.',
        },
        {
          code: 'return moves == n * n ? Status.DRAW : Status.IN_PROGRESS;',
          note: 'Reached only when the move did not win. That is why a win on the last cell is not a draw.',
        },
      ],
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
        note: 'The first six rows are the test "a full row wins for x"; the last is the move in "no move is allowed once the game is over". After the win `turn()` still names O, the player who would have been next. No test covers that.',
      },
      say: "I'll work the result out once per move and store it, so status is just a read and the game-over guard is one comparison. I only need the lines through the cell that was just played, and I check for a win before a draw because the last move can be both.",
      pitfalls: [
        'Testing for a full board before testing for a line: the ninth move that completes a line reports `DRAW`, and "a win on the last cell is not a draw" fails.',
        'Typing the eight lines of a 3 by 3 board as a table: it passes stage 2 and has to be thrown away in stage 3.',
        'Writing the anti-diagonal cell as `board[i][n - i]` where `n - 1 - i` is meant: the first move of every game throws `ArrayIndexOutOfBoundsException: Index 3 out of bounds for length 3`.',
        'Passing the turn before calling `outcome`: the scan then looks for the other player\'s marks, finds no line, and "a full row wins for x" fails with `expected X_WINS, got IN_PROGRESS`.',
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
      pseudocode: `new game with no size given:
  a new game of size 3

new game of size n:
  if n is less than 1: refuse, "board size must be at least 1"
  keep n
  an n by n grid, every cell empty

everything else stays as it is: it already reads n`,
      regions: ['constructors'],
      explain: [
        'This stage was decided in stage 1, when the size became a field and nothing else learned the number 3. The work is two constructors. `Game()` becomes `this(3)`, and `Game(int n)` checks the size and builds the grid. The bounds check, the win scan, the draw test and `toString` are untouched.',
        'Say that when the requirement arrives, before you type: "this should only touch the constructors, because everything reads `n`." Then run the tests and let them prove it. If a 3 did survive in a loop, the 4 by 4 tests are what find it.',
        'Refuse a size below 1. With `n = 0` every move is off the board and `moves == n * n` is true before anyone has played, so the game can never be in a sensible state. Size 1 is allowed and is a real edge: the first move fills the board and completes a line at once. Stage 2 checks the win before the draw, so the answer is `X_WINS`, and a test pins it.',
        'The costs now have an `n` in them: `n × n` references for the grid and one loop of `n` for each move. On 4 by 4 that is 16 cells and 4 steps. Stage 4 asks about the loop.',
      ],
      lines: [
        {
          code: 'this(3);',
          note: 'Constructor chaining: the no-argument constructor hands over to the sized one, so the default is written once and the size check covers both.',
        },
        { code: 'if (n < 1) {', note: '0 and negative sizes are refused with `IllegalArgumentException`. 1 is allowed.' },
        {
          code: 'this.n = n;',
          note: 'The parameter hides the field, so the field needs `this.`. Write `n = n;` and the compiler stops you with `variable n might not have been initialized`, because the `final` field is never set.',
        },
      ],
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
        note: 'This is the test "four by four needs four in a row"; every call returned normally. Two more runs of the same file: `new Game(0)` throws `IllegalArgumentException: board size must be at least 1, got 0`, and after `new Game(1)` the first move, `move(0, 0)`, gives `X_WINS`.',
      },
      say: "Everything already reads n, so this should only touch the constructors: the default one delegates with 3 and the sized one validates. I'll refuse sizes below 1, and I expect the existing tests to pass unchanged.",
      pitfalls: [
        'A 3 left in a loop or a bound from stage 1: all twelve earlier tests pass and the 4 by 4 tests fail, with `off the board: 0, 3` or with a game that ends after three in a row.',
        'Allowing `new Game(0)`: "a board smaller than one by one is refused" fails with `expected IllegalArgumentException, got nothing`.',
        'Leaving `Game()` to build its own grid: two constructors then hold the same lines, and the next field you add gets set in one and forgotten in the other.',
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
      regions: ['line-counts', 'sized-constructor', 'move', 'count', 'wins'],
      explain: [
        'Stop reading the board to find a win. Keep one integer for each line: `n` for the rows, `n` for the columns and one for each diagonal. A move adds `+1` for X or `-1` for O to the two, three or four counts its cell belongs to. A line has exactly `n` cells, so its count reaches `+n` only when X holds every one, and `-n` only when O does. One O in a row of X leaves the count at `n - 2` at most, so a mixed line can never look won.',
        'The scan from stage 2 goes, and `wins` becomes four comparisons. `move` gains one line, the call to `count`. The draw is still `moves == n * n`. The board stays, because `cell`, the taken-cell check and `toString` still read it. A move now costs the same on 3 by 3 as on 50 by 50, where the scan took a loop of `n`. The price is `2n + 2` integers: 8 on 3 by 3, 102 on 50 by 50.',
        '**Not one earlier test had to change.** The 17 tests of stages 1 to 3 pass on the new code as they were written, because they only ever call the constructors, `move`, `cell`, `turn`, `status` and `toString`. What sits behind those methods was replaced, and nothing outside the class can tell. The four stage 4 tests describe behaviour too, so they also pass on the stage 3 scan. They aim at the mistakes the counters invite (the centre cell, an even board, a mixed row), not at the counters. Say this in the room: it is what agreeing the API in the first five minutes, and testing only through it, bought you.',
        'Make the swap in two runs so the tests stay useful. First add the fields and `count`, call `count` from `move`, and run: everything passes, because the scan is still deciding. Then replace the body of `wins` and run again. If a test goes red now, the fault is in the few lines you have just typed.',
        'The counters depend on the rule being `n` in a row on an `n` by `n` board. A count says how many more X than O a line holds, not where they sit. For 5 in a row on a 15 by 15 board, a row can hold five X that are not adjacent, and the sum says nothing about a run. Name that limit before you are asked.',
      ],
      lines: [
        {
          code: 'count(row, col, weight(turn));',
          note: 'The one line `move` gains. It runs before `outcome`, while `turn` is still the mover. `count` takes a signed `delta` so that the same method can take a mark back out, which stage 5 needs.',
        },
        {
          code: 'if (row + col == n - 1) antiDiagonal += delta;',
          note: 'A second `if`, not an `else if`: the centre of an odd board is on both diagonals. With `else if` the centre never reaches the anti-diagonal count.',
        },
        {
          code: 'return player == Player.X ? 1 : -1;',
          note: 'Opposite signs make a mixed line cancel. Give both players `+1` and X, O, X in a row adds up to 3 and reads as a win.',
        },
        {
          code: 'return Math.abs(rows[row]) == n',
          note: '`Math.abs` covers both players in one comparison: `+n` is X and `-n` is O. Compare with `== n` alone and O never wins. Only the mover can have completed a line, so `outcome` still credits `turn`.',
        },
      ],
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
        note: 'This is the test "the centre counts for both diagonals". Every call returned normally. `diag` and `anti` are the fields `diagonal` and `antiDiagonal`.',
      },
      say: "The scan costs a loop of n per move, so I'll keep a running count for each row, each column and the two diagonals: plus one for X, minus one for O, and a line is won when its count reaches plus or minus n. The public methods don't change, so every existing test should pass untouched, and that's how I'll know the swap is safe.",
      pitfalls: [
        '`else if` on the second diagonal: the centre cell never reaches the anti-diagonal count, and "the centre counts for both diagonals" and "either diagonal wins" fail with `expected X_WINS, got IN_PROGRESS`.',
        'Writing the test in `count` as `row + col == n`: it counts the wrong cells, only `n - 1` of them, so the anti-diagonal can never reach `n` and three tests fail.',
        'Giving both players `+1`: a row of X, O, X counts 3 and reads as a win. The test "a row of mixed marks is not a win" fails, and so do seven other tests.',
        'Deleting the board because the counts seem to hold everything: `cell`, the taken-cell check and `toString` still read it.',
      ],
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
      regions: ['history', 'move', 'undo'],
      explain: [
        'Remember the moves, not the boards. The history is a stack of cells: `move` pushes one, `undo` pops one and reverses what `move` did. The obvious alternative is a copy of the whole board before every move, which costs `n × n` cells a move: 2,500 on a 50 by 50 board, against one small record here. Each undo is a fixed amount of work whatever the size.',
        'The stack is an `ArrayDeque` used through `push` and `pop`. A `record Cell(int row, int col)` holds the coordinates: that one line gives you the constructor and the accessors `row()` and `col()`. Only the cell is stored. The player is read back from the board before the cell is cleared.',
        '`undo` has to put back **five** things: the cell, the line counts, `moves`, the turn and the status. Go down `move` line by line and reverse each one. The counts are why `count` takes a signed `delta`: pass the opposite weight and the same method takes the mark out.',
        'The status needs no history of its own. No move is allowed once the game is over, so before any move, the winning one included, the game was in progress. Setting `IN_PROGRESS` is always right, and it is how a win gets taken back. Leave a comment there: it is the line a reviewer will stop at.',
        'Undo on a new game throws `IllegalStateException`, for the same reason a move after the end does: the call is well formed and the timing is wrong. Doing nothing in silence would hide a mistake in the caller. Say which you chose.',
      ],
      lines: [
        {
          code: 'private final Deque<Cell> history = new ArrayDeque<>();',
          note: '`ArrayDeque` as a stack: `push` and `pop` both work at the head, so the last move in is the first out. The older `java.util.Stack` extends `Vector` and its `pop` is `synchronized`.',
        },
        {
          code: 'Player player = board[last.row()][last.col()];',
          note: 'Read the mover from the board, before clearing the cell. `turn` is no use here: it passed to the other player when the move was made.',
        },
        {
          code: 'count(last.row(), last.col(), -weight(player));',
          note: 'The line that is easy to forget, and only one test catches it. Without it, undoing a win and replaying it takes row 0 to a count of 4 on a 3 by 3 board. 4 is not 3, so the replayed move does not win.',
        },
        {
          code: 'status = Status.IN_PROGRESS;',
          note: 'Without it the game stays won after the undo, and every later move is refused with `game is over: X_WINS`.',
        },
      ],
      trace: {
        caption: 'The undo puts every value back to the row above the winning move: row 0 from 3 to 2, the anti-diagonal from 0 to -1, the history from 5 to 4, the turn to X. Replaying the move wins again.',
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
        note: 'From the third row on this is the test "replaying an undone win wins again"; the second row is "undo on a new game is refused". `History` is the size of the stack.',
      },
      say: "I'll keep a stack of the cells played and have undo reverse each line of move: clear the cell, take its weight back out of the counts, drop the move count, hand the turn back. Status can simply go back to in progress, because no move is allowed after the end.",
      pitfalls: [
        'Restoring the cell and forgetting one of the other four: without the turn four tests fail, without the status three, and without the counts only "replaying an undone win wins again".',
        'Taking the player from `turn` after the move has passed it on: the weight has the wrong sign, the count moves further from zero, and "replaying an undone win wins again" reports `O_WINS`.',
        'Filling the deque with `add` and emptying it with `pop`: `add` goes on the tail and `pop` takes from the head, so undo removes the first move of the game and not the last.',
        'Letting undo on a new game return without a word: "undo on a new game is refused" fails with `expected IllegalStateException, got nothing`.',
      ],
    },
  ],
  followUps: [
    {
      q: 'Why exceptions, and not a boolean from `move`?',
      a: [
        "I'd keep exceptions. A bad move is the caller's mistake, and a boolean is easy to ignore and can't say whether the cell was taken, off the board, or the game was over.",
        "A caller who doesn't want exceptions can check `cell` and `status` first.",
        'The cost is that a screen must either check first or catch two exception types.',
      ],
    },
    {
      q: 'What does `turn()` return once the game is over?',
      a: [
        "In this code it still names the player who would have been next: O after X's winning move. No test covers it.",
        "I'd ask what you want. Returning `null` or throwing once the game is over is more honest, and it is a change to one method.",
        "Either way I'd write the choice down, because a screen will show it.",
      ],
    },
    {
      q: 'How would you add a screen without touching the rules?',
      a: [
        '`Game` holds the rules and the state and knows nothing about input or display. A console, a web page and the tests would all use the same five methods: `move`, `cell`, `turn`, `status` and `undo`.',
        '`toString` is for debugging. A real screen would read cells.',
        'That separation is also why the tests need no screen.',
      ],
    },
    {
      q: 'How would you test it more thoroughly?',
      a: [
        "First a table: for each board size, each of the `2n + 2` lines and each player, play that line with the other player's moves elsewhere and expect a win.",
        'Then random legal games, checking what must always hold: never a second winner, X has as many marks as O or one more, and a move followed by `undo` changes nothing.',
        "I'd also keep the stage 3 scan and compare it with the counters on those games. The cost is a second implementation to keep.",
      ],
    },
    {
      q: 'Is this class safe to call from two threads?',
      a: [
        'No. Two threads in `move` can both pass the taken-cell check, and updates to the turn and the counts can be lost.',
        'The simplest fix is `synchronized` on the public methods. One lock for each game is enough, because games are independent and moves are rare.',
        "On a server I'd go further and give each game one owner: a lock or an actor that all its moves go through.",
      ],
    },
    {
      q: 'What changes for five in a row on a 15 by 15 board, or for connect four?',
      a: [
        "The counters go. They work only because a line has exactly `n` cells and all must match; a count can't see whether five marks are next to each other.",
        "From the last move I'd walk outwards in four directions, both ways, counting the mover's marks until something else or the edge. Reach k in any direction and the mover wins.",
        'The work grows with k, not with the board. Connect four adds gravity: `move(col)` drops the mark to the lowest free row.',
      ],
    },
    {
      q: 'How would you add a computer player?',
      a: [
        "On 3 by 3 I'd use plain minimax: try every legal move, score where it leads, and pick the best on the assumption that the opponent does the same. The tree is small enough to search to the end, so it never loses.",
        '`undo` from stage 5 makes that cheap: try a move, recurse, take it back, with no copies of the board.',
        'Bigger boards need alpha-beta pruning, a depth limit with an estimated score, and a table of positions already scored.',
      ],
    },
    {
      q: 'What if the board were a billion by a billion, with five in a row to win?',
      a: [
        "I wouldn't allocate the grid, or a count for each row. I'd keep a map from cell to player that holds only the occupied cells, and do the walk from the last move with map lookups.",
        'The work for each move still grows only with k, and memory grows with the number of moves made.',
        "A draw by a full board stops meaning anything, so I'd ask for another rule to end the game.",
      ],
    },
    {
      q: 'How would you keep games in a database?',
      a: [
        'A `games` row with the size, the players, the status and a move count, and an append-only `moves` table keyed by game id and move number.',
        'A unique key on those two columns stops two writers both making move 7, and the moves table already gives me undo and replay.',
        "I'd rebuild the board by replaying the moves. For long games I'd add a snapshot, which costs a second thing to keep in step.",
      ],
    },
    {
      q: 'How would two people play over a network?',
      a: [
        'The server owns the game. Clients send moves and draw what the server tells them.',
        "Each move carries the game id, the player and its move number. The server applies it only if that number is next, so a retry does no harm and two clicks at once can't both land: the same idea as an [idempotency key](#/s/idempotency-keys).",
        'Moves on one game go through one lock or one actor. The other player hears by WebSocket or long polling, at the cost of a connection held open for each player.',
      ],
    },
  ],
  mistakes: [
    'Typing before asking how a bad move is reported, then reworking `move` and everything that calls it.',
    'Writing a console loop that reads moves and prints the board. Nobody asked for it and no test runs it.',
    'Typing the eight winning lines of a 3 by 3 board as a table, then throwing the table away when the board becomes n by n.',
    'Reaching for the counters in stage 2. The scan is short and plainly right, and its tests are what make the counters safe to add later.',
    'Working in silence because the task is easy. The code is simple, so what you say is most of what the two people watching have to go on: name each decision before you type it.',
    'Staring at a failing test when `System.out.println(game)` would show the board at once.',
  ],
  see: [
    { href: '#/s/stack', label: 'Stack', why: 'The history in stage 5: the last move pushed is the first one undone.' },
    { href: '#/s/hash-table', label: 'Hash table', why: 'The map from cell to player that replaces the grid on a huge, mostly empty board.' },
    { href: '#/s/idempotency-keys', label: 'Idempotency keys', why: 'Why a move number sent with each move makes a retried request harmless.' },
  ],
  simplified: [
    'No input parsing, no screen and no game loop: one class and its tests.',
    'One thread. Two callers in `move` at the same moment can corrupt the game.',
    'No game ids, no player identities and nothing saved.',
    'X always moves first.',
    'No redo. A new move after an undo replaces what was undone.',
    '`turn()` still names a player after the game has ended, and no test says what it should do.',
    'Coordinates are two plain `int`s, row then column. The public API has no cell or move type.',
    'In stage 5 `moves` always equals `history.size()`. It is kept so that stage 5 changes as little as possible; a reviewer could remove it.',
    'No test measures time. The 50 by 50 test shows the counters work on a bigger board; that the check takes constant time is read off the code.',
  ],
  unverified: [
    'That plain minimax can search 3 by 3 tic-tac-toe to the end and then never loses, and that alpha-beta pruning, a depth limit and a table of scored positions are the usual next steps: general knowledge, not run here.',
    'The network answer (move numbers, one lock or actor for each game, WebSocket or long polling) and the database answer (an append-only moves table with a unique key): common designs described from memory; none was built.',
    'The table tests, the random-game checks and the comparison against the scan in the testing answer were not written or run.',
    'That `synchronized` on the public methods is enough for two threads was reasoned from the code, not tested with threads.',
    'The outward walk for k in a row and the map for a huge board were not written or run.',
    'That an easy task is set to see how a candidate works, and that the talking counts for more than the code, is this page\'s judgement and not something checked against a source.',
  ],
};

export default page;
