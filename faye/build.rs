fn main() {
    println!("cargo:rerun-if-changed=assets/faye.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("assets/faye.ico")
            .set("ProductName", "faye")
            .set("FileDescription", "faye CLI agent")
            .set("OriginalFilename", "faye.exe")
            .compile()
            .expect("failed to embed the faye Windows icon");
    }
}
