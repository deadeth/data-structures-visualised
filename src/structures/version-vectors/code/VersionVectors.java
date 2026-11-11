import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/** Three leaders, A, B and C, that each accept writes for one key. */
public class VersionVectors {
    static final String SIBLINGS = "siblings";
    static final String LWW = "lww";

    enum Order { EQUAL, AHEAD, BEHIND, CONCURRENT }

    /** A stored value and the version vector that says what it has seen. */
    record Version(String name, Set<String> cart, int[] vv, int ts, int writer) {}

    static final Version START = new Version("v0", Set.of(), new int[3], 0, -1);

    /** A leader. It holds one version of the key, or several siblings. */
    static class Replica {
        final int skew; // how far this replica's wall clock is off
        List<Version> versions = new ArrayList<>(List.of(START));

        Replica(int skew) {
            this.skew = skew;
        }
    }

    String policy;
    int now = 10; // real time, in ticks
    int made = 0;
    final List<Replica> replicas = new ArrayList<>();

    public VersionVectors(String policy, int... skews) {
        this.policy = policy;
        for (int skew : skews) {
            replicas.add(new Replica(skew));
        }
    }

    // region compare
    /** Compares two version vectors entry by entry. */
    static Order compare(Version v, Version w) {
        boolean ahead = false;
        boolean behind = false;
        for (int i = 0; i < v.vv().length; i++) { //@entry
            if (v.vv()[i] > w.vv()[i]) { //@entry
                ahead = true; //@ahead
            } else if (v.vv()[i] < w.vv()[i]) { //@elif
                behind = true; //@behind
            }
        }
        if (ahead && behind) { //@concurrent,dominates,covered
            return Order.CONCURRENT; //@concurrent
        }
        if (ahead) { //@dominates,covered
            return Order.AHEAD; //@dominates
        }
        return behind ? Order.BEHIND : Order.EQUAL; //@covered
    }
    // endregion

    // region newer
    /** Last write wins: the later timestamp, ties to the later replica. */
    static boolean newer(Version v, Version w) {
        if (v.ts() != w.ts()) { //@lww
            return v.ts() > w.ts(); //@lww
        }
        return v.writer() > w.writer(); //@lww
    }
    // endregion

    // region stamp
    /** A new version, timed by the writing replica's own clock. */
    Version stamp(Set<String> cart, int[] vv, int r) {
        now++; // the page's clock moves one tick per write
        made++;
        int ts = now + replicas.get(r).skew; //@stamp
        return new Version("v" + made, cart, vv, ts, r); //@stamp
    }
    // endregion

    // region write
    /** A client reads the replica's cart, toggles one item, writes. */
    public Version write(int r, String item) {
        Replica rep = replicas.get(r);
        if (rep.versions.size() > 1) { //@check
            return null; //@refuse
        }
        Version base = rep.versions.get(0); //@read
        Set<String> cart = new TreeSet<>(base.cart()); //@cart
        if (!cart.remove(item)) { //@cart
            cart.add(item); //@cart
        }
        int[] vv = base.vv().clone(); //@bump
        vv[r]++; //@bump
        Version v = stamp(cart, vv, r); //@stamp
        rep.versions = new ArrayList<>(List.of(v)); //@replace
        return v; //@written
    }
    // endregion

    // region replicate
    /** Sends every version src holds to dst. */
    public List<Version> replicate(int src, int dst) {
        Replica target = replicas.get(dst);
        for (Version v : List.copyOf(replicas.get(src).versions)) { //@each
            boolean keep = true;
            for (Version w : List.copyOf(target.versions)) { //@against
                Order order = compare(v, w); //@against
                if (order == Order.EQUAL || order == Order.BEHIND) { //@known
                    keep = false; //@known
                    break; //@known
                }
                if (order == Order.AHEAD) { //@supersede
                    target.versions.remove(w); //@supersede
                } else if (policy.equals(SIBLINGS)) { //@sibling
                    continue; //@sibling
                } else if (newer(v, w)) { //@lww
                    target.versions.remove(w); //@lost_old
                } else {
                    keep = false; //@lost_new
                    break; //@lost_new
                }
            }
            if (keep) { //@keep
                target.versions.add(v); //@keep
            }
        }
        return target.versions; //@done
    }
    // endregion

    // region resolve
    /** A client merges the siblings at a replica into one version. */
    public Version resolve(int r) {
        List<Version> sibs = replicas.get(r).versions;
        if (sibs.size() < 2) { //@check
            return null; //@nothing
        }
        int[] vv = new int[sibs.get(0).vv().length];
        for (int i = 0; i < vv.length; i++) { //@max
            for (Version s : sibs) { //@max
                vv[i] = Math.max(vv[i], s.vv()[i]); //@max
            }
        }
        Set<String> cart = new TreeSet<>();
        for (Version s : sibs) { //@union
            cart.addAll(s.cart()); //@union
        }
        vv[r]++; //@bump
        Version v = stamp(cart, vv, r); //@stamp
        replicas.get(r).versions = new ArrayList<>(List.of(v)); //@replace
        return v; //@merged
    }
    // endregion

    // region concurrent
    /** Two clients write before either replica hears of the other. */
    public List<Version> concurrent(int x, String itemX, int y, String itemY) {
        write(x, itemX); //@first
        write(y, itemY); //@second
        return replicate(x, y); //@sync
    }
    // endregion

    // region set_policy
    /** Page only: switches the policy and starts the key again. */
    public void setPolicy(String policy) {
        this.policy = policy; //@policy
        for (Replica rep : replicas) { //@reset
            rep.versions = new ArrayList<>(List.of(START)); //@reset
        }
    }
    // endregion
}
