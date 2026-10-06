//! A small git-shaped object store for boards: blobs (Mermaid sources),
//! trees (board snapshots) and commits, all addressed by SHA-256.

use crate::diff::{DiffLine, line_diff, merge3, normalize};
use crate::mermaid::{SemChange, semantic_diff};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

pub type Result<T> = std::result::Result<T, String>;

/// The working copy of one diagram on the canvas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub id: String,
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub source: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Board {
    pub frames: Vec<Frame>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub id: String,
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub tree: String,
    pub parents: Vec<String>,
    pub message: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Object {
    Blob { data: String },
    Tree { entries: Vec<TreeEntry> },
    Commit(Commit),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "target", rename_all = "lowercase")]
pub enum Head {
    Branch(String),
    Detached(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    objects: BTreeMap<String, Object>,
    branches: BTreeMap<String, String>,
    head: Head,
    #[serde(default)]
    merge_head: Option<String>,
    #[serde(default)]
    merge_branch: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Status {
    pub branch: Option<String>,
    pub head: String,
    pub dirty: bool,
    pub merging: Option<String>,
    pub branches: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct LogEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub message: String,
    pub author: String,
    pub time: i64,
    pub refs: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct FrameDiff {
    pub id: String,
    pub title: String,
    /// added | removed | modified | renamed | moved
    pub status: &'static str,
    pub lines: Vec<DiffLine>,
    pub semantic: Vec<SemChange>,
}

#[derive(Debug, Serialize)]
pub struct Conflict {
    pub id: String,
    pub title: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct MergeOutcome {
    /// up-to-date | fast-forward | merged | conflicts
    pub kind: &'static str,
    pub board: Board,
    pub commit: Option<String>,
    pub conflicts: Vec<Conflict>,
}

fn hash_obj(o: &Object) -> String {
    let json = serde_json::to_string(o).expect("objects serialise");
    Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn short(h: &str) -> &str {
    &h[..7.min(h.len())]
}

fn tree_entries(board: &Board) -> (Vec<TreeEntry>, Vec<Object>) {
    let mut blobs = Vec::new();
    let mut entries: Vec<TreeEntry> = board
        .frames
        .iter()
        .map(|f| {
            let blob = Object::Blob { data: normalize(&f.source) };
            let hash = hash_obj(&blob);
            blobs.push(blob);
            TreeEntry { id: f.id.clone(), title: f.title.clone(), x: f.x, y: f.y, w: f.w, h: f.h, blob: hash }
        })
        .collect();
    entries.sort_by(|a, b| a.id.cmp(&b.id));
    (entries, blobs)
}

impl Repo {
    pub fn init(board: &Board, author: &str, time: i64) -> Repo {
        let mut repo = Repo {
            objects: BTreeMap::new(),
            branches: BTreeMap::new(),
            head: Head::Branch("main".into()),
            merge_head: None,
            merge_branch: None,
        };
        let tree = repo.write_board(board);
        let commit = repo.put(Object::Commit(Commit {
            tree,
            parents: vec![],
            message: "Initial board".into(),
            author: author.into(),
            time,
        }));
        repo.branches.insert("main".into(), commit);
        repo
    }

    /// A repo with no commits, to be filled by `ingest` + `set_ref` from a remote.
    pub fn empty(branch: &str) -> Repo {
        Repo {
            objects: BTreeMap::new(),
            branches: BTreeMap::new(),
            head: Head::Branch(branch.into()),
            merge_head: None,
            merge_branch: None,
        }
    }

    /// Serialised objects reachable from `tips` but not from `exclude`, keyed by hash.
    /// The JSON strings are exactly what was hashed, so receivers can verify them.
    pub fn pack(&self, tips: &[String], exclude: &[String]) -> Result<BTreeMap<String, String>> {
        let mut seen: HashSet<String> = exclude.iter().cloned().collect();
        let mut stack: Vec<String> = tips.iter().map(|t| self.resolve(t)).collect::<Result<_>>()?;
        let mut out = BTreeMap::new();
        while let Some(h) = stack.pop() {
            if !seen.insert(h.clone()) {
                continue;
            }
            let Some(o) = self.objects.get(&h) else { continue };
            match o {
                Object::Commit(c) => {
                    stack.push(c.tree.clone());
                    stack.extend(c.parents.iter().cloned());
                }
                Object::Tree { entries } => stack.extend(entries.iter().map(|e| e.blob.clone())),
                Object::Blob { .. } => {}
            }
            out.insert(h, serde_json::to_string(o).map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Adds serialised objects, rejecting any whose content doesn't match its hash.
    pub fn ingest(&mut self, objects: &BTreeMap<String, String>) -> Result<usize> {
        let mut added = 0;
        for (hash, json) in objects {
            let actual: String = Sha256::digest(json.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            if &actual != hash {
                return Err(format!("object {} failed verification", short(hash)));
            }
            if !self.objects.contains_key(hash) {
                let o: Object = serde_json::from_str(json).map_err(|e| format!("bad object {}: {e}", short(hash)))?;
                self.objects.insert(hash.clone(), o);
                added += 1;
            }
        }
        Ok(added)
    }

    /// Points a branch at a commit (or deletes it), as dictated by the remote.
    pub fn set_ref(&mut self, name: &str, hash: Option<&str>) -> Result<()> {
        match hash {
            Some(h) => {
                self.commit_obj(h)?;
                self.branches.insert(name.into(), h.into());
            }
            None => {
                self.branches.remove(name);
            }
        }
        Ok(())
    }

    /// Merge state is shared between collaborators, so it can be set from outside.
    pub fn set_merge(&mut self, head: Option<String>, branch: Option<String>) {
        self.merge_head = head;
        self.merge_branch = branch;
    }

    fn put(&mut self, o: Object) -> String {
        let h = hash_obj(&o);
        self.objects.entry(h.clone()).or_insert(o);
        h
    }

    fn write_board(&mut self, board: &Board) -> String {
        let (entries, blobs) = tree_entries(board);
        for b in blobs {
            self.put(b);
        }
        self.put(Object::Tree { entries })
    }

    fn tree_hash(board: &Board) -> String {
        hash_obj(&Object::Tree { entries: tree_entries(board).0 })
    }

    fn commit_obj(&self, h: &str) -> Result<&Commit> {
        match self.objects.get(h) {
            Some(Object::Commit(c)) => Ok(c),
            _ => Err(format!("{} is not a commit", short(h))),
        }
    }

    fn read_tree(&self, tree: &str) -> Result<Board> {
        let Some(Object::Tree { entries }) = self.objects.get(tree) else {
            return Err(format!("missing tree {}", short(tree)));
        };
        let frames = entries
            .iter()
            .map(|e| match self.objects.get(&e.blob) {
                Some(Object::Blob { data }) => Ok(Frame {
                    id: e.id.clone(),
                    title: e.title.clone(),
                    x: e.x,
                    y: e.y,
                    w: e.w,
                    h: e.h,
                    source: data.clone(),
                }),
                _ => Err(format!("missing blob {}", short(&e.blob))),
            })
            .collect::<Result<_>>()?;
        Ok(Board { frames })
    }

    pub fn board_at(&self, rev: &str) -> Result<Board> {
        let h = self.resolve(rev)?;
        self.read_tree(&self.commit_obj(&h)?.tree)
    }

    pub fn head_hash(&self) -> String {
        match &self.head {
            Head::Branch(b) => self.branches.get(b).cloned().unwrap_or_default(),
            Head::Detached(h) => h.clone(),
        }
    }

    fn head_label(&self) -> String {
        match &self.head {
            Head::Branch(b) => b.clone(),
            Head::Detached(h) => short(h).to_string(),
        }
    }

    fn set_head_target(&mut self, hash: String) {
        match &self.head {
            Head::Branch(b) => {
                self.branches.insert(b.clone(), hash);
            }
            Head::Detached(_) => self.head = Head::Detached(hash),
        }
    }

    /// `HEAD`, a branch name, or a (≥4 char) commit hash prefix.
    pub fn resolve(&self, rev: &str) -> Result<String> {
        if rev == "HEAD" {
            return Ok(self.head_hash());
        }
        if let Some(h) = self.branches.get(rev) {
            return Ok(h.clone());
        }
        if rev.len() >= 4 {
            let found: Vec<&String> = self
                .objects
                .range(rev.to_string()..)
                .take_while(|(k, _)| k.starts_with(rev))
                .filter(|(_, o)| matches!(o, Object::Commit(_)))
                .map(|(k, _)| k)
                .collect();
            match found.as_slice() {
                [one] => return Ok((*one).clone()),
                [] => {}
                _ => return Err(format!("ambiguous revision '{rev}'")),
            }
        }
        Err(format!("unknown revision '{rev}'"))
    }

    pub fn is_dirty(&self, board: &Board) -> bool {
        let head_tree = self.commit_obj(&self.head_hash()).map(|c| c.tree.clone()).unwrap_or_default();
        Self::tree_hash(board) != head_tree
    }

    pub fn status(&self, board: &Board) -> Status {
        Status {
            branch: match &self.head {
                Head::Branch(b) => Some(b.clone()),
                Head::Detached(_) => None,
            },
            head: self.head_hash(),
            dirty: self.is_dirty(board),
            merging: self.merge_branch.clone(),
            branches: self.branches.keys().cloned().collect(),
        }
    }

    pub fn commit(&mut self, board: &Board, message: &str, author: &str, time: i64) -> Result<String> {
        let message = message.trim();
        if message.is_empty() {
            return Err("A commit message is required".into());
        }
        if board.frames.iter().any(|f| f.source.contains("%% <<<<<<<")) {
            return Err("Resolve the conflict markers before committing".into());
        }
        let head = self.head_hash();
        let parent = self.commit_obj(&head)?.clone();
        let tree = self.write_board(board);
        if tree == parent.tree && self.merge_head.is_none() {
            return Err("Nothing to commit".into());
        }
        let mut parents = vec![head];
        parents.extend(self.merge_head.take());
        self.merge_branch = None;
        let commit = self.put(Object::Commit(Commit {
            tree,
            parents,
            message: message.into(),
            author: author.into(),
            // Keep history monotonic even if the client clock goes backwards.
            time: time.max(parent.time + 1),
        }));
        self.set_head_target(commit.clone());
        Ok(commit)
    }

    pub fn checkout(&mut self, rev: &str) -> Result<Board> {
        if self.merge_head.is_some() {
            return Err("Finish or abort the merge first".into());
        }
        let head = if self.branches.contains_key(rev) {
            Head::Branch(rev.into())
        } else {
            Head::Detached(self.resolve(rev)?)
        };
        self.head = head;
        self.board_at("HEAD")
    }

    pub fn create_branch(&mut self, name: &str, rev: &str) -> Result<()> {
        let valid = !name.is_empty()
            && name != "HEAD"
            && !name.starts_with(['-', '/'])
            && name.chars().all(|c| c.is_alphanumeric() || "-_/.".contains(c));
        if !valid {
            return Err(format!("'{name}' is not a valid branch name"));
        }
        if self.branches.contains_key(name) {
            return Err(format!("branch '{name}' already exists"));
        }
        let target = self.resolve(rev)?;
        self.commit_obj(&target)?;
        self.branches.insert(name.into(), target);
        Ok(())
    }

    /// Switch to an existing branch without touching the working board
    /// (used right after creating a branch at HEAD, like `git switch -c`).
    pub fn attach(&mut self, name: &str) -> Result<()> {
        if !self.branches.contains_key(name) {
            return Err(format!("unknown branch '{name}'"));
        }
        self.head = Head::Branch(name.into());
        Ok(())
    }

    pub fn delete_branch(&mut self, name: &str) -> Result<()> {
        if self.head == Head::Branch(name.into()) {
            return Err("Can't delete the checked-out branch".into());
        }
        self.branches.remove(name).map(|_| ()).ok_or_else(|| format!("unknown branch '{name}'"))
    }

    /// Every commit reachable from a branch or HEAD, newest first.
    pub fn log(&self) -> Vec<LogEntry> {
        let mut refs: HashMap<&str, Vec<String>> = HashMap::new();
        for (name, h) in &self.branches {
            refs.entry(h).or_default().push(name.clone());
        }
        if let Head::Detached(h) = &self.head {
            refs.entry(h).or_default().insert(0, "HEAD".into());
        }

        let mut seen = HashSet::new();
        let mut stack: Vec<String> = self.branches.values().cloned().chain([self.head_hash()]).collect();
        let mut out = Vec::new();
        while let Some(h) = stack.pop() {
            if !seen.insert(h.clone()) {
                continue;
            }
            let Ok(c) = self.commit_obj(&h) else { continue };
            stack.extend(c.parents.iter().cloned());
            out.push(LogEntry {
                refs: refs.get(h.as_str()).cloned().unwrap_or_default(),
                hash: h,
                parents: c.parents.clone(),
                message: c.message.clone(),
                author: c.author.clone(),
                time: c.time,
            });
        }
        out.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.hash.cmp(&b.hash)));
        out
    }

    fn ancestors(&self, h: &str) -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut queue = VecDeque::from([h.to_string()]);
        while let Some(h) = queue.pop_front() {
            if let Ok(c) = self.commit_obj(&h) {
                queue.extend(c.parents.iter().cloned());
            }
            seen.insert(h);
        }
        seen
    }

    /// The most recent common ancestor of two commits.
    fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        let anc_a = self.ancestors(a);
        self.ancestors(b)
            .into_iter()
            .filter(|h| anc_a.contains(h))
            .max_by_key(|h| self.commit_obj(h).map(|c| c.time).unwrap_or(i64::MIN))
    }

    pub fn merge(&mut self, branch: &str, board: &Board, author: &str, time: i64) -> Result<MergeOutcome> {
        if self.merge_head.is_some() {
            return Err("A merge is already in progress".into());
        }
        if self.is_dirty(board) {
            return Err("Commit or discard your changes before merging".into());
        }
        let ours = self.head_hash();
        let theirs = self.resolve(branch)?;
        let outcome = |kind, board, commit, conflicts| MergeOutcome { kind, board, commit, conflicts };

        if self.ancestors(&ours).contains(&theirs) {
            return Ok(outcome("up-to-date", board.clone(), None, vec![]));
        }
        let base = self.merge_base(&ours, &theirs).ok_or("These histories share no common ancestor")?;
        if base == ours {
            self.set_head_target(theirs.clone());
            return Ok(outcome("fast-forward", self.board_at("HEAD")?, Some(theirs), vec![]));
        }

        let labels = (self.head_label(), branch.to_string());
        let (merged, conflicts) = merge_boards(
            &self.board_at(&base)?,
            &self.board_at(&ours)?,
            &self.board_at(&theirs)?,
            (&labels.0, &labels.1),
        );
        self.merge_head = Some(theirs);
        self.merge_branch = Some(branch.into());
        if !conflicts.is_empty() {
            return Ok(outcome("conflicts", merged, None, conflicts));
        }
        let message = format!("Merge branch '{}' into {}", labels.1, labels.0);
        let commit = self.commit(&merged, &message, author, time)?;
        Ok(outcome("merged", merged, Some(commit), vec![]))
    }

    pub fn merge_abort(&mut self) -> Result<Board> {
        self.merge_head = None;
        self.merge_branch = None;
        self.board_at("HEAD")
    }

    pub fn diff(&self, from: &str, to: &Board) -> Result<Vec<FrameDiff>> {
        Ok(diff_boards(&self.board_at(from)?, to))
    }

    /// What a single commit changed relative to its first parent.
    pub fn commit_diff(&self, rev: &str) -> Result<Vec<FrameDiff>> {
        let h = self.resolve(rev)?;
        let c = self.commit_obj(&h)?;
        let before = match c.parents.first() {
            Some(p) => self.board_at(p)?,
            None => Board::default(),
        };
        Ok(diff_boards(&before, &self.read_tree(&c.tree)?))
    }
}

fn geometry(f: &Frame) -> (i64, i64, i64, i64) {
    (f.x, f.y, f.w, f.h)
}

pub fn diff_boards(old: &Board, new: &Board) -> Vec<FrameDiff> {
    let old_by_id: HashMap<&str, &Frame> = old.frames.iter().map(|f| (f.id.as_str(), f)).collect();
    let new_ids: HashSet<&str> = new.frames.iter().map(|f| f.id.as_str()).collect();
    let mut out = Vec::new();

    for f in &new.frames {
        let src = normalize(&f.source);
        let Some(o) = old_by_id.get(f.id.as_str()) else {
            out.push(FrameDiff {
                id: f.id.clone(),
                title: f.title.clone(),
                status: "added",
                lines: line_diff("", &src),
                semantic: semantic_diff("", &src),
            });
            continue;
        };
        let old_src = normalize(&o.source);
        let status = if old_src != src {
            "modified"
        } else if o.title != f.title {
            "renamed"
        } else if geometry(o) != geometry(f) {
            "moved"
        } else {
            continue;
        };
        let (lines, semantic) = if status == "modified" {
            (line_diff(&old_src, &src), semantic_diff(&old_src, &src))
        } else {
            (vec![], vec![])
        };
        out.push(FrameDiff { id: f.id.clone(), title: f.title.clone(), status, lines, semantic });
    }
    for o in old.frames.iter().filter(|o| !new_ids.contains(o.id.as_str())) {
        let src = normalize(&o.source);
        out.push(FrameDiff {
            id: o.id.clone(),
            title: o.title.clone(),
            status: "removed",
            lines: line_diff(&src, ""),
            semantic: semantic_diff(&src, ""),
        });
    }
    out
}

/// Take whichever side changed relative to base; ours wins if both did.
fn pick<T: PartialEq + Clone>(base: &T, ours: &T, theirs: &T) -> T {
    if ours == base { theirs.clone() } else { ours.clone() }
}

pub fn merge_boards(base: &Board, ours: &Board, theirs: &Board, labels: (&str, &str)) -> (Board, Vec<Conflict>) {
    let index = |b: &Board| b.frames.iter().map(|f| (f.id.clone(), f.clone())).collect::<HashMap<_, _>>();
    let (bi, oi, ti) = (index(base), index(ours), index(theirs));

    let mut ids: Vec<&String> = ours.frames.iter().map(|f| &f.id).collect();
    ids.extend(theirs.frames.iter().map(|f| &f.id).filter(|id| !oi.contains_key(*id)));
    ids.extend(base.frames.iter().map(|f| &f.id).filter(|id| !oi.contains_key(*id) && !ti.contains_key(*id)));

    let mut frames = Vec::new();
    let mut conflicts = Vec::new();
    let conflict = |f: &Frame, reason: String| Conflict { id: f.id.clone(), title: f.title.clone(), reason };

    for id in ids {
        match (bi.get(id), oi.get(id), ti.get(id)) {
            (b, Some(o), Some(t)) => {
                let base_src = b.map(|f| f.source.as_str()).unwrap_or("");
                let m = merge3(base_src, &o.source, &t.source, labels);
                let (title, (x, y, w, h)) = match b {
                    Some(b) => (pick(&b.title, &o.title, &t.title), pick(&geometry(b), &geometry(o), &geometry(t))),
                    None => (o.title.clone(), geometry(o)),
                };
                let f = Frame { id: id.clone(), title, x, y, w, h, source: m.text };
                if m.conflicts > 0 {
                    let n = m.conflicts;
                    conflicts.push(conflict(&f, format!("{n} conflicting hunk{}", if n == 1 { "" } else { "s" })));
                }
                frames.push(f);
            }
            (Some(b), Some(o), None) if o != b => {
                conflicts.push(conflict(o, format!("edited on {}, deleted on {}", labels.0, labels.1)));
                frames.push(o.clone());
            }
            (Some(b), None, Some(t)) if t != b => {
                conflicts.push(conflict(t, format!("deleted on {}, edited on {}", labels.0, labels.1)));
                frames.push(t.clone());
            }
            (None, Some(f), None) | (None, None, Some(f)) => frames.push(f.clone()),
            _ => {} // deleted on one side and untouched on the other, or deleted on both
        }
    }
    (Board { frames }, conflicts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: &str, source: &str) -> Frame {
        Frame { id: id.into(), title: id.into(), x: 0, y: 0, w: 400, h: 300, source: source.into() }
    }

    fn board(frames: &[Frame]) -> Board {
        Board { frames: frames.to_vec() }
    }

    #[test]
    fn commit_checkout_roundtrip() {
        let b1 = board(&[frame("a", "graph TD\n A-->B")]);
        let mut r = Repo::init(&b1, "me", 1);
        assert!(!r.is_dirty(&b1));
        assert_eq!(r.commit(&b1, "noop", "me", 2), Err("Nothing to commit".into()));

        let b2 = board(&[frame("a", "graph TD\n A-->C")]);
        let c2 = r.commit(&b2, "edit", "me", 2).unwrap();
        assert_eq!(r.resolve(&c2[..8]).unwrap(), c2);
        let first = r.log().last().unwrap().hash.clone();
        assert_eq!(r.checkout(&first).unwrap(), b1);
        assert_eq!(r.status(&b1).branch, None);
        assert_eq!(r.checkout("main").unwrap(), b2);
    }

    #[test]
    fn whitespace_only_changes_are_clean() {
        let b = board(&[frame("a", "graph TD\n A-->B")]);
        let r = Repo::init(&b, "me", 1);
        assert!(!r.is_dirty(&board(&[frame("a", "graph TD  \n A-->B\n\n")])));
    }

    #[test]
    fn fast_forward_and_three_way_merge() {
        let base = board(&[frame("a", "graph TD\n A-->B"), frame("s", "sequenceDiagram\n A->>B: hi")]);
        let mut r = Repo::init(&base, "me", 1);
        r.create_branch("feat", "HEAD").unwrap();
        r.checkout("feat").unwrap();
        let feat = board(&[frame("a", "graph TD\n A-->B\n B-->C"), frame("s", "sequenceDiagram\n A->>B: hi")]);
        r.commit(&feat, "feat work", "me", 2).unwrap();

        // main hasn't moved: fast-forward
        r.checkout("main").unwrap();
        let ff = r.merge("feat", &base, "me", 3).unwrap();
        assert_eq!(ff.kind, "fast-forward");
        assert_eq!(ff.board, feat);

        // diverge: main edits the sequence diagram, feat edits the flowchart
        let main2 = board(&[frame("a", "graph TD\n A-->B\n B-->C"), frame("s", "sequenceDiagram\n A->>B: hello")]);
        r.commit(&main2, "main work", "me", 4).unwrap();
        r.checkout("feat").unwrap();
        let feat2 = board(&[frame("a", "graph LR\n A-->B\n B-->C"), frame("s", "sequenceDiagram\n A->>B: hi")]);
        r.commit(&feat2, "feat work 2", "me", 5).unwrap();
        r.checkout("main").unwrap();

        let m = r.merge("feat", &main2, "me", 6).unwrap();
        assert_eq!(m.kind, "merged");
        assert_eq!(m.board.frames[0].source, "graph LR\n A-->B\n B-->C");
        assert_eq!(m.board.frames[1].source, "sequenceDiagram\n A->>B: hello");
        let head = r.log().into_iter().next().unwrap();
        assert_eq!(head.parents.len(), 2);
        assert_eq!(r.merge("feat", &m.board, "me", 7).unwrap().kind, "up-to-date");
    }

    #[test]
    fn conflicting_merge_waits_for_resolution() {
        let base = board(&[frame("a", "graph TD\n A-->B")]);
        let mut r = Repo::init(&base, "me", 1);
        r.create_branch("feat", "HEAD").unwrap();
        r.commit(&board(&[frame("a", "graph TD\n A-->C")]), "main", "me", 2).unwrap();
        r.checkout("feat").unwrap();
        r.commit(&board(&[frame("a", "graph TD\n A-->D")]), "feat", "me", 3).unwrap();
        let ours = r.checkout("main").unwrap();

        let m = r.merge("feat", &ours, "me", 4).unwrap();
        assert_eq!(m.kind, "conflicts");
        assert_eq!(m.conflicts.len(), 1);
        assert!(r.commit(&m.board, "merge", "me", 5).is_err());
        assert!(r.checkout("feat").is_err());

        let resolved = board(&[frame("a", "graph TD\n A-->C\n A-->D")]);
        r.commit(&resolved, "Merge feat", "me", 5).unwrap();
        assert_eq!(r.log()[0].parents.len(), 2);
        assert_eq!(r.status(&resolved).merging, None);
    }

    #[test]
    fn delete_vs_edit_is_a_conflict() {
        let base = board(&[frame("a", "graph TD\n A-->B"), frame("b", "graph TD\n X-->Y")]);
        let ours = board(&[frame("a", "graph TD\n A-->B")]); // deleted b
        let theirs = board(&[frame("a", "graph TD\n A-->B"), frame("b", "graph TD\n X-->Z")]);
        let (merged, conflicts) = merge_boards(&base, &ours, &theirs, ("main", "feat"));
        assert_eq!(merged.frames.len(), 2);
        assert_eq!(conflicts[0].reason, "deleted on main, edited on feat");

        let untouched = board(&[frame("a", "graph TD\n A-->B"), frame("b", "graph TD\n X-->Y")]);
        let (merged, conflicts) = merge_boards(&base, &ours, &untouched, ("main", "feat"));
        assert_eq!((merged.frames.len(), conflicts.len()), (1, 0));
    }

    #[test]
    fn pack_and_ingest_sync_two_repos() {
        let b1 = board(&[frame("a", "graph TD\n A-->B")]);
        let mut server_side = Repo::init(&b1, "me", 1);
        let first = server_side.head_hash();
        let b2 = board(&[frame("a", "graph TD\n A-->C")]);
        let second = server_side.commit(&b2, "edit", "me", 2).unwrap();

        let mut client = Repo::empty("main");
        client.ingest(&server_side.pack(&[first.clone()], &[]).unwrap()).unwrap();
        client.set_ref("main", Some(&first)).unwrap();
        assert_eq!(client.board_at("HEAD").unwrap(), b1);

        // Incremental: only the new commit, its tree and the changed blob.
        let delta = server_side.pack(&[second.clone()], &[first]).unwrap();
        assert_eq!(delta.len(), 3);
        client.ingest(&delta).unwrap();
        client.set_ref("main", Some(&second)).unwrap();
        assert_eq!(client.board_at("HEAD").unwrap(), b2);

        let mut tampered = delta.clone();
        let (h, json) = tampered.iter_mut().next().unwrap();
        json.push(' ');
        assert!(Repo::empty("main").ingest(&BTreeMap::from([(h.clone(), json.clone())])).is_err());
    }

    #[test]
    fn export_import_roundtrip() {
        let b = board(&[frame("a", "graph TD\n A-->B")]);
        let r = Repo::init(&b, "me", 1);
        let json = serde_json::to_string(&r).unwrap();
        let r2: Repo = serde_json::from_str(&json).unwrap();
        assert_eq!(r2.board_at("main").unwrap(), b);
    }
}
