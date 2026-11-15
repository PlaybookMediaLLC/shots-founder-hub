use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../postgres");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut paths = fs::read_dir(root.join("migrations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .collect::<Vec<_>>();
    paths.sort();
    paths.insert(0, root.join("bootstrap.sql"));
    let mut source = String::from("pub const MIGRATIONS: &[(&str, &str)] = &[\n");
    for path in paths {
        source.push_str(&format!(
            "({:?}, include_str!({:?})),\n",
            path.file_name().unwrap(),
            path
        ));
    }
    source.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        source,
    )
    .unwrap();
}
