#[tokio::main]
async fn main() {
    let result = async {
        let url = std::env::var("DATABASE_URL").map_err(|_| cloud_db::Error::Configuration)?;
        let database = cloud_db::Database::new(&url)?;
        cloud_db::migrations::migrate(&database).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("PostgreSQL migration failed: {error}");
        std::process::exit(1);
    }
    println!("PostgreSQL migrations applied");
}
