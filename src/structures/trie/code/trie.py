class Node:
    def __init__(self):
        self.children = {}  # letter -> Node
        self.end = False  # True if the path to here spells a stored word


class Trie:
    LIMIT = 8  # the most words a prefix query returns

    def __init__(self):
        self.root = Node()  # stands for the empty string

    # region walk
    def _walk(self, word):
        """Walk down from the root, one lookup per letter."""
        node = self.root  #@start
        path = [node]
        for ch in word:
            # One dict lookup, not a scan of the children.
            child = node.children.get(ch)  #@lookup
            if child is None:
                return path, False  #@miss
            node = child  #@down
            path.append(node)
        return path, True
    # endregion

    # region search
    def search(self, word):  #@call
        path, complete = self._walk(word)
        if not complete:
            return False  #@missing
        # A prefix of a longer word is not a word.
        return path[-1].end  #@result
    # endregion

    # region insert
    def insert(self, word):  #@call
        node = self.root  #@start
        for ch in word:
            child = node.children.get(ch)  #@lookup
            if child is None:  #@absent
                child = Node()  #@create
                node.children[ch] = child  #@create
            node = child  #@down
        if node.end:
            return False  #@duplicate
        node.end = True  #@mark_end
        return True  #@done
    # endregion

    # region delete
    def delete(self, word):  #@call
        path, complete = self._walk(word)
        if not complete:
            return False  #@missing
        if not path[-1].end:
            return False  #@prefix_only
        path[-1].end = False  #@unmark
        # Prune upwards: path[i] is reached after i letters.
        for i in range(len(word), 0, -1):
            node = path[i]
            if node.children or node.end:  #@prune
                break  # still needed  #@kept
            del path[i - 1].children[word[i - 1]]  #@prune
        return True  #@done
    # endregion

    # region prefix
    def with_prefix(self, prefix):  #@call
        """The first LIMIT words that start with prefix."""
        path, complete = self._walk(prefix)
        if not complete:
            return []  #@none
        out = []
        stack = [(path[-1], prefix)]
        while stack:
            node, text = stack.pop()  #@visit
            if node.end:
                out.append(text)  #@collect
                if len(out) == self.LIMIT:
                    break  #@limit
            # Reversed, so the smallest letter pops first.
            for ch in sorted(node.children, reverse=True):
                stack.append((node.children[ch], text + ch))
        return out  #@done
    # endregion
