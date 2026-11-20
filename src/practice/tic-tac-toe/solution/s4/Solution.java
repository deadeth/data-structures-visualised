import java.util.*;

/*
 * Tic-tac-toe. "Implement tic-tac-toe for two players. I should be able
 * to make moves and ask who has won."
 *
 * Player and Status are given; write the Game class under "Your code".
 * main runs the tests of each stage up to STAGE. When they pass, add one.
 */
public class Solution {

    // ===== Supplied code: do not change =====

    enum Player { X, O }
    enum Status { IN_PROGRESS, X_WINS, O_WINS, DRAW }

    // ===== Your code =====

    static final class Game {
        private final int n;
        private final Player[][] board;
        private Player turn = Player.X;
        private Status status = Status.IN_PROGRESS;
        private int moves;
        // region line-counts
        // One count per line: +1 for each X in it, -1 for each O.
        private final int[] rows;
        private final int[] cols;
        private int diagonal;
        private int antiDiagonal;
        // endregion

        Game() {
            this(3);
        }

        // region sized-constructor
        Game(int n) {
            if (n < 1) {
                throw new IllegalArgumentException(
                        "board size must be at least 1, got " + n);
            }
            this.n = n;
            board = new Player[n][n];
            rows = new int[n];
            cols = new int[n];
        }
        // endregion

        // region move
        void move(int row, int col) {
            if (status != Status.IN_PROGRESS) {
                throw new IllegalStateException("game is over: " + status);
            }
            requireOnBoard(row, col);
            if (board[row][col] != null) {
                throw new IllegalArgumentException(
                        "cell taken: " + row + ", " + col);
            }
            board[row][col] = turn;
            count(row, col, weight(turn));
            moves++;
            status = outcome(row, col);
            turn = turn == Player.X ? Player.O : Player.X;
        }
        // endregion

        // region count
        private static int weight(Player player) {
            return player == Player.X ? 1 : -1;
        }

        private void count(int row, int col, int delta) {
            rows[row] += delta;
            cols[col] += delta;
            if (row == col) diagonal += delta;
            if (row + col == n - 1) antiDiagonal += delta;
        }
        // endregion

        private void requireOnBoard(int row, int col) {
            if (row < 0 || row >= n || col < 0 || col >= n) {
                throw new IllegalArgumentException(
                        "off the board: " + row + ", " + col);
            }
        }

        // Called after the mark is placed and before the turn passes.
        private Status outcome(int row, int col) {
            if (wins(row, col)) {
                return turn == Player.X ? Status.X_WINS : Status.O_WINS;
            }
            return moves == n * n ? Status.DRAW : Status.IN_PROGRESS;
        }

        // region wins
        // A line has n cells, so a count of n or -n means one player holds
        // all of them. Only lines through the last move can have changed.
        private boolean wins(int row, int col) {
            return Math.abs(rows[row]) == n
                    || Math.abs(cols[col]) == n
                    || row == col && Math.abs(diagonal) == n
                    || row + col == n - 1 && Math.abs(antiDiagonal) == n;
        }
        // endregion

        Player cell(int row, int col) {
            requireOnBoard(row, col);
            return board[row][col];
        }

        Player turn() {
            return turn;
        }

        Status status() {
            return status;
        }

        // TODO stage 5: take back the last move.
        void undo() {
            throw new UnsupportedOperationException("stage 5");
        }

        @Override
        public String toString() {
            var out = new StringBuilder();
            for (int r = 0; r < n; r++) {
                if (r > 0) out.append('\n');
                for (int c = 0; c < n; c++) {
                    out.append(board[r][c] == null ? "." : board[r][c]);
                }
            }
            return out.toString();
        }
    }

    // ===== Tests: set STAGE to run more =====

    static final int STAGE = 4;

    public static void main(String[] args) {
        if (STAGE >= 1) stage1();
        if (STAGE >= 2) stage2();
        if (STAGE >= 3) stage3();
        if (STAGE >= 4) stage4();
        if (STAGE >= 5) stage5();
        System.out.println(failed == 0 ? "ALL PASSED" : failed + " FAILED");
    }

    // Stage 1. A 3 by 3 board. X moves first, then the players take turns.
    // Reject a move off the board or onto a taken cell, and say why.
    // Let me read any cell, and print the board.
    static void stage1() {
        test("new game is empty and x moves first", () -> {
            var g = new Game();
            expect(null, g.cell(0, 0));
            expect("...\n...\n...", g.toString());
            expect(Player.X, g.turn());
        });
        test("a move marks the cell and passes the turn", () -> {
            var g = new Game();
            g.move(1, 1);
            expect(Player.X, g.cell(1, 1));
            expect(Player.O, g.turn());
        });
        test("players take turns", () -> {
            var g = play(new Game(), 0, 0, 0, 1, 0, 2);
            expect("XOX", "" + g.cell(0, 0) + g.cell(0, 1) + g.cell(0, 2));
            expect(Player.O, g.turn());
        });
        test("a move off the board is rejected", () -> {
            var g = new Game();
            expect("IllegalArgumentException", thrown(() -> g.move(3, 0)));
            expect("IllegalArgumentException", thrown(() -> g.move(0, -1)));
            expect(Player.X, g.turn());
        });
        test("a move on a taken cell is rejected", () -> {
            var g = new Game();
            g.move(0, 0);
            expect("IllegalArgumentException", thrown(() -> g.move(0, 0)));
            expect(Player.X, g.cell(0, 0));
            expect(Player.O, g.turn());
        });
        test("the board prints row by row", () -> {
            var g = play(new Game(), 0, 0, 1, 1, 2, 2);
            expect("X..\n.O.\n..X", g.toString());
        });
        report(1);
    }

    // Stage 2. Tell me where the game stands: X has won, O has won, a draw,
    // or still in progress. A full row, column or diagonal wins. A full
    // board with no line is a draw. Nobody may move once the game is over.
    static void stage2() {
        test("a full row wins for x", () -> {
            var g = play(new Game(), 0, 0, 1, 0, 0, 1, 1, 1);
            expect(Status.IN_PROGRESS, g.status());
            g.move(0, 2);
            expect(Status.X_WINS, g.status());
        });
        test("a full column wins for o", () -> {
            var g = play(new Game(), 0, 0, 0, 1, 1, 0, 1, 1, 2, 2, 2, 1);
            expect(Status.O_WINS, g.status());
        });
        test("either diagonal wins", () -> {
            var a = play(new Game(), 0, 0, 0, 1, 1, 1, 0, 2, 2, 2);
            expect(Status.X_WINS, a.status());
            var b = play(new Game(), 0, 2, 0, 0, 1, 1, 0, 1, 2, 0);
            expect(Status.X_WINS, b.status());
        });
        test("a full board with no line is a draw", () -> {
            var g = play(new Game(),
                    0, 0, 0, 1, 0, 2, 1, 1, 1, 0, 1, 2, 2, 1, 2, 0);
            expect(Status.IN_PROGRESS, g.status());
            g.move(2, 2);
            expect(Status.DRAW, g.status());
        });
        test("a win on the last cell is not a draw", () -> {
            var g = play(new Game(),
                    0, 0, 0, 1, 0, 2, 1, 0, 2, 1, 1, 2, 1, 1, 2, 0, 2, 2);
            expect(Status.X_WINS, g.status());
        });
        test("no move is allowed once the game is over", () -> {
            var g = play(new Game(), 0, 0, 1, 0, 0, 1, 1, 1, 0, 2);
            expect("IllegalStateException", thrown(() -> g.move(2, 2)));
            expect(null, g.cell(2, 2));
        });
        report(2);
    }

    // Stage 3. Play on any n by n board, where a full line of n wins.
    // new Game() is still 3 by 3. Refuse a board smaller than 1 by 1.
    static void stage3() {
        test("four by four needs four in a row", () -> {
            var g = play(new Game(4), 0, 0, 1, 0, 0, 1, 1, 1, 0, 2, 1, 2);
            expect(Status.IN_PROGRESS, g.status());
            g.move(0, 3);
            expect(Status.X_WINS, g.status());
        });
        test("four by four reaches every cell and no further", () -> {
            var g = new Game(4);
            g.move(3, 3);
            expect(Player.X, g.cell(3, 3));
            expect("IllegalArgumentException", thrown(() -> g.move(4, 0)));
        });
        test("four by four can end in a draw", () -> {
            var g = play(new Game(4),
                    0, 0, 0, 2, 0, 1, 0, 3, 1, 2, 1, 0, 1, 3, 1, 1,
                    2, 0, 2, 2, 2, 1, 2, 3, 3, 2, 3, 0, 3, 3, 3, 1);
            expect(Status.DRAW, g.status());
        });
        test("on one by one the first move wins", () -> {
            var g = new Game(1);
            g.move(0, 0);
            expect(Status.X_WINS, g.status());
        });
        test("a board smaller than one by one is refused", () -> {
            expect("IllegalArgumentException", thrown(() -> new Game(0)));
            expect("IllegalArgumentException", thrown(() -> new Game(-1)));
        });
        report(3);
    }

    // Stage 4. Boards may be large. Make the win check after each move take
    // the same time however big the board is. Every earlier test must
    // still pass without changing it.
    static void stage4() {
        test("the centre counts for both diagonals", () -> {
            var g = play(new Game(), 1, 1, 0, 0, 2, 0, 1, 0, 0, 2);
            expect(Status.X_WINS, g.status());
        });
        test("the anti-diagonal wins on an even board", () -> {
            var g = play(new Game(4), 0, 3, 0, 0, 1, 2, 0, 1, 2, 1, 0, 2, 3, 0);
            expect(Status.X_WINS, g.status());
        });
        test("a row of mixed marks is not a win", () -> {
            var g = play(new Game(), 0, 0, 0, 1, 0, 2);
            expect(Status.IN_PROGRESS, g.status());
        });
        test("a long row wins on a 50 by 50 board", () -> {
            var g = new Game(50);
            for (int c = 0; c < 49; c++) {
                g.move(0, c);
                g.move(1, c);
            }
            expect(Status.IN_PROGRESS, g.status());
            g.move(0, 49);
            expect(Status.X_WINS, g.status());
        });
        report(4);
    }

    // Stage 5. Let players take moves back. undo removes the last move;
    // calling it again removes the one before. After an undo the game is
    // exactly as it was before that move, even if the move won.
    static void stage5() {
        test("undo on a new game is refused", () -> {
            var g = new Game();
            expect("IllegalStateException", thrown(g::undo));
        });
        test("undo takes back the last move and the turn", () -> {
            var g = play(new Game(), 0, 0, 1, 1);
            g.undo();
            expect(null, g.cell(1, 1));
            expect(Player.X, g.cell(0, 0));
            expect(Player.O, g.turn());
        });
        test("undo twice takes back two moves", () -> {
            var g = play(new Game(), 0, 0, 1, 1);
            g.undo();
            g.undo();
            expect("...\n...\n...", g.toString());
            expect(Player.X, g.turn());
        });
        test("undoing a win puts the game back in progress", () -> {
            var g = play(new Game(), 0, 0, 1, 0, 0, 1, 1, 1, 0, 2);
            g.undo();
            expect(Status.IN_PROGRESS, g.status());
            expect(Player.X, g.turn());
        });
        test("after undoing a win a different move counts", () -> {
            var g = play(new Game(), 0, 0, 1, 0, 0, 1, 1, 1, 0, 2);
            g.undo();
            play(g, 2, 2, 0, 2);
            expect(Player.O, g.cell(0, 2));
            expect(Status.IN_PROGRESS, g.status());
        });
        test("replaying an undone win wins again", () -> {
            var g = play(new Game(), 0, 0, 1, 0, 0, 1, 1, 1, 0, 2);
            g.undo();
            g.move(0, 2);
            expect(Status.X_WINS, g.status());
        });
        report(5);
    }

    // Plays moves given as row, column pairs, and returns the game.
    static Game play(Game g, int... cells) {
        for (int i = 0; i < cells.length; i += 2) {
            g.move(cells[i], cells[i + 1]);
        }
        return g;
    }

    // The simple name of the exception the call throws, or "nothing".
    static String thrown(Runnable call) {
        try {
            call.run();
            return "nothing";
        } catch (RuntimeException e) {
            return e.getClass().getSimpleName();
        }
    }

    static int failed, passed, total;

    static void test(String name, Runnable body) {
        total++;
        try {
            body.run();
            passed++;
            System.out.println("PASS " + name);
        } catch (RuntimeException | Error e) {
            failed++;
            String why = e instanceof AssertionError
                    ? e.getMessage() : "threw " + e;
            System.out.println("FAIL " + name + ": " + why);
        }
    }

    static void expect(Object expected, Object actual) {
        if (!Objects.equals(expected, actual)) {
            throw new AssertionError("expected " + expected
                    + ", got " + actual);
        }
    }

    static void report(int stage) {
        System.out.printf("Stage %d: %d/%d passed%n", stage, passed, total);
        passed = total = 0;
    }
}
