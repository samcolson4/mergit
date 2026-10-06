//! A lenient flowchart parser, just deep enough to produce semantic diffs
//! ("added node X", "removed edge A → B") instead of only line diffs.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, PartialEq)]
pub struct Graph {
    pub nodes: BTreeMap<String, String>,
    pub edges: BTreeSet<(String, String, String)>,
}

const SKIP: &[&str] = &["subgraph", "end", "classDef", "class", "style", "linkStyle", "click", "direction"];

pub fn parse_flowchart(src: &str) -> Option<Graph> {
    let mut lines = src.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("%%"));
    let header = lines.next()?;
    let kw = header.split_whitespace().next()?;
    if kw != "flowchart" && kw != "graph" {
        return None;
    }
    let mut g = Graph::default();
    let rest = header.split(';').skip(1);
    for line in rest.chain(lines.flat_map(|l| l.split(';'))) {
        let stmt = line.trim();
        let first = stmt.split_whitespace().next().unwrap_or("");
        if !stmt.is_empty() && !SKIP.contains(&first) {
            parse_statement(stmt, &mut g);
        }
    }
    Some(g)
}

fn is_id(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn skip_ws(c: &[char], p: &mut usize) {
    while *p < c.len() && c[*p].is_whitespace() {
        *p += 1;
    }
}

fn parse_statement(stmt: &str, g: &mut Graph) {
    let c: Vec<char> = stmt.chars().collect();
    let mut p = 0;
    let Some(mut prev) = node(&c, &mut p, g) else { return };
    loop {
        skip_ws(&c, &mut p);
        let Some(label) = arrow(&c, &mut p) else { return };
        skip_ws(&c, &mut p);
        let Some(next) = node(&c, &mut p, g) else { return };
        g.edges.insert((prev, next.clone(), label));
        prev = next;
    }
}

/// `id`, optionally followed by a shape such as `[label]`, `(label)`, `{label}`, `((label))`, `>label]`.
fn node(c: &[char], p: &mut usize, g: &mut Graph) -> Option<String> {
    let start = *p;
    while *p < c.len() && is_id(c[*p]) {
        *p += 1;
    }
    if start == *p {
        return None;
    }
    let id: String = c[start..*p].iter().collect();

    if *p < c.len() && "([{>".contains(c[*p]) {
        let shape_start = *p;
        let asymmetric = c[*p] == '>';
        let mut depth = 0i32;
        let mut in_quote = false;
        while *p < c.len() {
            let ch = c[*p];
            *p += 1;
            if ch == '"' {
                in_quote = !in_quote;
            } else if in_quote {
            } else if asymmetric {
                if ch == ']' {
                    break;
                }
            } else if "([{".contains(ch) {
                depth += 1;
            } else if ")]}".contains(ch) {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
        }
        let raw: String = c[shape_start..*p].iter().collect();
        let label = raw.trim_matches(|ch| "()[]{}>/\\\"".contains(ch)).trim().to_string();
        g.nodes.insert(id.clone(), label);
    } else {
        g.nodes.entry(id.clone()).or_insert_with(|| id.clone());
    }

    // `:::className` suffix
    if c[*p..].starts_with(&[':', ':', ':']) {
        *p += 3;
        while *p < c.len() && is_id(c[*p]) {
            *p += 1;
        }
    }
    Some(id)
}

const ARROW: &str = "-=.<>~";

/// Consumes a link such as `-->`, `-.->`, `==>`, `---`, `-->|label|` or `-- label -->`.
/// Returns the link label (empty if none).
fn arrow(c: &[char], p: &mut usize) -> Option<String> {
    let start = *p;
    while *p < c.len() && ARROW.contains(c[*p]) {
        *p += 1;
    }
    // Circle / cross heads: `--o`, `--x`
    if *p > start && *p < c.len() && "ox".contains(c[*p]) && !c.get(*p + 1).is_some_and(|&n| is_id(n)) {
        *p += 1;
    }
    let token: String = c[start..*p].iter().collect();
    if token.len() < 2 {
        *p = start;
        return None;
    }

    skip_ws(c, p);
    if *p < c.len() && c[*p] == '|' {
        let s = *p + 1;
        let e = c[s..].iter().position(|&ch| ch == '|').map(|i| s + i)?;
        *p = e + 1;
        return Some(c[s..e].iter().collect::<String>().trim().to_string());
    }

    // `A -- text --> B` / `A -. text .-> B` / `A == text ==> B`
    if matches!(token.as_str(), "--" | "==" | "-.") {
        let s = *p;
        let mut e = s;
        while e + 1 < c.len() && !(ARROW.contains(c[e]) && ARROW.contains(c[e + 1])) {
            e += 1;
        }
        let label: String = c[s..e].iter().collect::<String>().trim().to_string();
        *p = e;
        while *p < c.len() && ARROW.contains(c[*p]) {
            *p += 1;
        }
        return Some(label);
    }
    Some(String::new())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SemChange {
    pub kind: &'static str,
    pub text: String,
}

fn edge_text((from, to, label): &(String, String, String)) -> String {
    if label.is_empty() {
        format!("{from} → {to}")
    } else {
        format!("{from} → {to} ({label})")
    }
}

/// Semantic diff between two flowchart sources. Empty when either side isn't a flowchart.
pub fn semantic_diff(old: &str, new: &str) -> Vec<SemChange> {
    let empty = |s: &str| s.trim().is_empty();
    let a = if empty(old) { Some(Graph::default()) } else { parse_flowchart(old) };
    let b = if empty(new) { Some(Graph::default()) } else { parse_flowchart(new) };
    let (Some(a), Some(b)) = (a, b) else { return vec![] };

    let mut out = Vec::new();
    let change = |kind, text| SemChange { kind, text };
    for (id, label) in &b.nodes {
        match a.nodes.get(id) {
            None => out.push(change("add", format!("node {id} “{label}”"))),
            Some(old) if old != label => {
                out.push(change("change", format!("node {id}: “{old}” → “{label}”")))
            }
            _ => {}
        }
    }
    for (id, label) in &a.nodes {
        if !b.nodes.contains_key(id) {
            out.push(change("remove", format!("node {id} “{label}”")));
        }
    }
    for e in b.edges.difference(&a.edges) {
        out.push(change("add", format!("edge {}", edge_text(e))));
    }
    for e in a.edges.difference(&b.edges) {
        out.push(change("remove", format!("edge {}", edge_text(e))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edges(g: &Graph) -> Vec<String> {
        g.edges.iter().map(edge_text).collect()
    }

    #[test]
    fn parses_common_syntax() {
        let g = parse_flowchart(
            "flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C((Done))\n  B -- no --> D(Retry) -.-> A\n  E>Flag] ==> F[(DB)]:::db",
        )
        .unwrap();
        assert_eq!(g.nodes["A"], "Start");
        assert_eq!(g.nodes["B"], "Ok?");
        assert_eq!(g.nodes["C"], "Done");
        assert_eq!(g.nodes["E"], "Flag");
        assert_eq!(g.nodes["F"], "DB");
        assert_eq!(
            edges(&g),
            ["A → B", "B → C (yes)", "B → D (no)", "D → A", "E → F"]
        );
    }

    #[test]
    fn non_flowcharts_are_skipped() {
        assert!(parse_flowchart("sequenceDiagram\n  A->>B: hi").is_none());
    }

    #[test]
    fn semantic_diff_reports_nodes_and_edges() {
        let d = semantic_diff("graph TD\n A[One] --> B", "graph TD\n A[Uno] --> C");
        let texts: Vec<_> = d.iter().map(|c| (c.kind, c.text.as_str())).collect();
        assert_eq!(
            texts,
            [
                ("change", "node A: “One” → “Uno”"),
                ("add", "node C “C”"),
                ("remove", "node B “B”"),
                ("add", "edge A → C"),
                ("remove", "edge A → B"),
            ]
        );
    }
}
