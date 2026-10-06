//! Line diffs and three-way merges over Mermaid sources.

use serde::Serialize;

/// Canonical form of a source: no trailing whitespace on lines, no trailing blank lines.
pub fn normalize(src: &str) -> String {
    let lines: Vec<&str> = src.lines().map(str::trim_end).collect();
    lines.join("\n").trim_end_matches('\n').to_string()
}

fn lines(src: &str) -> Vec<&str> {
    src.lines().collect()
}

/// For each line of `a`, the line of `b` it is paired with by a longest common subsequence.
/// Quadratic, which is fine for diagram-sized inputs; swap for Myers/patience if boards grow.
fn lcs_match(a: &[&str], b: &[&str]) -> Vec<Option<usize>> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![0u32; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[at(i, j)] = if a[i] == b[j] {
                dp[at(i + 1, j + 1)] + 1
            } else {
                dp[at(i + 1, j)].max(dp[at(i, j + 1)])
            };
        }
    }
    let mut out = vec![None; n];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            out[i] = Some(j);
            i += 1;
            j += 1;
        } else if dp[at(i + 1, j)] >= dp[at(i, j + 1)] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiffLine {
    pub op: char,
    pub text: String,
}

pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    let a = lines(old);
    let b = lines(new);
    let matched = lcs_match(&a, &b);
    let mut out = Vec::new();
    let line = |op, text: &str| DiffLine { op, text: text.to_string() };
    let mut j = 0;
    for (i, text) in a.iter().enumerate() {
        match matched[i] {
            Some(k) => {
                out.extend(b[j..k].iter().map(|t| line('+', t)));
                out.push(line(' ', text));
                j = k + 1;
            }
            None => out.push(line('-', text)),
        }
    }
    out.extend(b[j..].iter().map(|t| line('+', t)));
    out
}

pub struct Merged {
    pub text: String,
    pub conflicts: usize,
}

/// diff3-style merge. Conflicts are written as Mermaid `%%` comments so the
/// frame still renders (showing the union of both sides) while it is being resolved.
pub fn merge3(base: &str, ours: &str, theirs: &str, labels: (&str, &str)) -> Merged {
    let o = lines(base);
    let a = lines(ours);
    let b = lines(theirs);
    let ma = lcs_match(&o, &a);
    let mb = lcs_match(&o, &b);

    let (mut io, mut ia, mut ib) = (0, 0, 0);
    let mut out: Vec<String> = Vec::new();
    let mut conflicts = 0;
    loop {
        // Next base line that both sides kept: a synchronisation point.
        let mut k = io;
        while k < o.len() && !(ma[k].is_some_and(|x| x >= ia) && mb[k].is_some_and(|y| y >= ib)) {
            k += 1;
        }
        let (ea, eb) = if k < o.len() {
            (ma[k].unwrap(), mb[k].unwrap())
        } else {
            (a.len(), b.len())
        };

        if k == io && ea == ia && eb == ib {
            if k == o.len() {
                break;
            }
            out.push(o[k].to_string());
            io += 1;
            ia += 1;
            ib += 1;
            continue;
        }

        let (co, ca, cb) = (&o[io..k], &a[ia..ea], &b[ib..eb]);
        let take = |s: &[&str], out: &mut Vec<String>| out.extend(s.iter().map(|l| l.to_string()));
        if ca == co {
            take(cb, &mut out);
        } else if cb == co || ca == cb {
            take(ca, &mut out);
        } else {
            conflicts += 1;
            out.push(format!("%% <<<<<<< {}", labels.0));
            take(ca, &mut out);
            out.push("%% =======".to_string());
            take(cb, &mut out);
            out.push(format!("%% >>>>>>> {}", labels.1));
        }
        io = k;
        ia = ea;
        ib = eb;
    }
    Merged { text: out.join("\n"), conflicts }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_marks_changes() {
        let d = line_diff("a\nb\nc", "a\nB\nc\nd");
        let ops: String = d.iter().map(|l| l.op).collect();
        assert_eq!(ops, " -+ +");
    }

    #[test]
    fn merges_disjoint_edits() {
        let base = "flowchart LR\n  A --> B\n  B --> C\n  C --> D";
        let ours = "flowchart TD\n  A --> B\n  B --> C\n  C --> D";
        let theirs = "flowchart LR\n  A --> B\n  B --> C\n  C --> D\n  D --> E";
        let m = merge3(base, ours, theirs, ("ours", "theirs"));
        assert_eq!(m.conflicts, 0);
        assert_eq!(m.text, "flowchart TD\n  A --> B\n  B --> C\n  C --> D\n  D --> E");
    }

    #[test]
    fn conflicting_edits_get_comment_markers() {
        let m = merge3("x\nA-->B\ny", "x\nA-->C\ny", "x\nA-->D\ny", ("main", "feat"));
        assert_eq!(m.conflicts, 1);
        assert_eq!(
            m.text,
            "x\n%% <<<<<<< main\nA-->C\n%% =======\nA-->D\n%% >>>>>>> feat\ny"
        );
    }

    #[test]
    fn identical_edits_are_not_conflicts() {
        let m = merge3("a\nb", "a\nc", "a\nc", ("o", "t"));
        assert_eq!((m.conflicts, m.text.as_str()), (0, "a\nc"));
    }
}
