use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    process::{Output, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
struct Request {
    path: String,
    headers: BTreeMap<String, String>,
    body: Value,
}
struct Reply {
    status: u16,
    body: String,
    stream: bool,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            body: value.to_string(),
            stream: false,
        }
    }
    fn events(events: Vec<Value>, done: bool) -> Self {
        let mut body = events
            .into_iter()
            .map(|e| format!("data: {e}\n\n"))
            .collect::<String>();
        if done {
            body.push_str("data: [DONE]\n\n");
        }
        Self {
            status: 200,
            body,
            stream: true,
        }
    }
    fn chat(text: &str) -> Self {
        Self::events(
            vec![
                json!({"choices":[{"delta":{"content":text}}]}),
                json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
                json!({"choices":[],"usage":{"total_tokens":10}}),
            ],
            true,
        )
    }
    fn tool(name: &str, args: Value, usage: u64) -> Self {
        Self::events(
            vec![
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":name,"arguments":args.to_string()}}]}}]}),
                json!({"choices":[],"usage":{"total_tokens":usage}}),
            ],
            true,
        )
    }
}

struct Fixture {
    temp: tempfile::TempDir,
    base: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(handler: impl Fn(Request) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (thread_stop, thread_requests) = (stop.clone(), requests.clone());
        let thread = thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("mock accept: {e}"),
                };
                // Windows accepted sockets inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                if reader.read_line(&mut first).unwrap_or(0) == 0 {
                    continue;
                }
                let path = first.split_whitespace().nth(1).unwrap().to_string();
                let mut headers = BTreeMap::new();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let (key, value) = line.split_once(':').unwrap();
                    headers.insert(key.to_lowercase(), value.trim().to_string());
                }
                let length = headers
                    .get("content-length")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let request = Request {
                    path,
                    headers,
                    body,
                };
                thread_requests.lock().unwrap().push(request.clone());
                let reply = handler(request);
                let header = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nRetry-After: 0\r\nConnection: close\r\n\r\n",
                    reply.status,
                    if reply.stream {
                        "text/event-stream"
                    } else {
                        "application/json"
                    },
                    reply.body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(reply.body.as_bytes());
            }
        });
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("home")).unwrap();
        std::fs::create_dir_all(temp.path().join("project")).unwrap();
        let fixture = Self {
            temp,
            base: format!("http://{address}/v1"),
            requests,
            stop,
            thread: Some(thread),
        };
        fixture.config("chat-completions", 100000);
        fixture
    }
    fn config(&self, style: &str, cap: u64) {
        self.save_config(json!({"api_style":style,"base_url":self.base,"api_key":"mock-secret","model":"mock-model","thinking_effort":"default","context_length":cap}));
    }
    fn save_config(&self, config: Value) {
        std::fs::write(
            self.temp.path().join("home/config.json"),
            config.to_string(),
        )
        .unwrap();
    }
    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.temp.path().join("home/config.json")).unwrap())
            .unwrap()
    }
    fn posts(&self) -> Vec<Request> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| !r.body.is_null())
            .cloned()
            .collect()
    }
    fn hint_path(&self) -> std::path::PathBuf {
        let project = self.temp.path().join("project");
        let name: String = project
            .to_string_lossy()
            .chars()
            .map(|c| match c {
                '\\' | '/' | ':' => '_',
                _ => c,
            })
            .collect();
        self.temp
            .path()
            .join("home/hints")
            .join(format!("{name}.md"))
    }
    async fn run(&self, args: &[&str], input: &str, overrides: &[(&str, &str)]) -> Output {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_faye"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("FAYE_") {
                command.env_remove(key);
            }
        }
        command
            .args(args)
            .current_dir(self.temp.path().join("project"))
            .env("FAYE_HOME", self.temp.path().join("home"))
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in overrides {
            command.env(key, value);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
            .await
            .expect("CLI timed out")
            .unwrap()
    }
    async fn login(&self, style: &str, number: &str, effort: &str) -> Output {
        self.run(
            &["login"],
            &format!("{style}\n{}\nmock-secret\n{number}\n{effort}\n", self.base),
            &[],
        )
        .await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn success(output: &Output) -> String {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout.clone()).unwrap()
}
fn models() -> Reply {
    Reply::json(json!({"data":[{"id":"mock-model","max_model_len":100000}]}))
}

#[tokio::test]
async fn login_lists_all_pages_selects_number_and_uses_saved_effort() {
    let fixture = Fixture::new(|r| {
        assert_eq!(
            r.headers.get("authorization").unwrap(),
            "Bearer mock-secret"
        );
        if r.path == "/v1/models" {
            Reply::json(json!({"data":[{"id":"first-model"}],"next":"/v1/models?page=2"}))
        } else if r.path.starts_with("/v1/models?") {
            models()
        } else {
            assert_eq!(r.body["model"], "mock-model");
            assert_eq!(r.body["reasoning_effort"], "high");
            Reply::chat("done")
        }
    });
    let output = success(&fixture.login("1", "2", "high").await);
    assert!(output.contains("1. first-model") && output.contains("2. mock-model"));
    assert!(output.contains("API Key（隐藏输入"));
    assert!(
        !output.contains("mock-secret")
            && !output.contains("锛")
            && !output.contains("DeepSeek / vLLM")
    );
    assert_eq!(fixture.saved()["model"], "mock-model");
    assert_eq!(fixture.saved()["context_length"], 100000);
    assert!(fixture.posts().is_empty());
    success(&fixture.run(&["-u", "hello"], "", &[]).await);
}

#[tokio::test]
async fn invalid_interface_and_model_numbers_reprompt() {
    let fixture = Fixture::new(|_| models());
    let output = success(
        &fixture
            .run(
                &["login"],
                &format!(
                    "4\n1\n{}\nmock-secret\n0\n99\nmock-model\n1\ndefault\n",
                    fixture.base
                ),
                &[],
            )
            .await,
    );
    assert!(output.contains("请选择 1 至 3"));
    assert_eq!(output.matches("请输入 1 至 1 的模型序号").count(), 3);
    assert_eq!(fixture.saved()["model"], "mock-model");
}

#[tokio::test]
async fn failed_model_discovery_preserves_previous_config() {
    for reply in [
        Reply {
            status: 401,
            body: "unauthorized".into(),
            stream: false,
        },
        Reply::json(json!({"data":[]})),
        Reply::json(json!({"data":[{"id":"mock-model"}],"next":"http://127.0.0.1:1/models"})),
    ] {
        let response = Mutex::new(Some(reply));
        let fixture = Fixture::new(move |_| response.lock().unwrap().take().unwrap());
        let previous = fixture.saved();
        let output = fixture.login("1", "1", "default").await;
        assert!(!output.status.success());
        assert_eq!(fixture.saved(), previous);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn anthropic_model_pagination_uses_native_auth() {
    let fixture = Fixture::new(|r| {
        assert_eq!(r.headers.get("x-api-key").unwrap(), "mock-secret");
        assert_eq!(r.headers.get("anthropic-version").unwrap(), "2023-06-01");
        if r.path.contains("after_id=") {
            models()
        } else {
            Reply::json(
                json!({"data":[{"id":"first-model"}],"has_more":true,"last_id":"first-model"}),
            )
        }
    });
    success(&fixture.login("3", "2", "high").await);
    assert_eq!(fixture.saved()["api_style"], "anthropic");
}

#[tokio::test]
async fn environment_overrides_saved_configuration() {
    let fixture = Fixture::new(|r| {
        if r.body.is_null() {
            models()
        } else {
            assert_eq!(r.body["model"], "mock-model");
            assert_eq!(r.body["reasoning_effort"], "high");
            Reply::chat("done")
        }
    });
    let mut config = fixture.saved();
    config["model"] = json!("saved-model");
    fixture.save_config(config);
    success(
        &fixture
            .run(
                &["-u", "hello"],
                "",
                &[
                    ("FAYE_MODEL_NAME", "mock-model"),
                    ("FAYE_THINKING_EFFORT", "high"),
                ],
            )
            .await,
    );
}

#[tokio::test]
async fn help_and_session_commands_do_not_need_a_key() {
    let fixture = Fixture::new(|_| panic!("no network expected"));
    std::fs::remove_file(fixture.temp.path().join("home/config.json")).unwrap();
    for args in [
        &["--help"][..],
        &["--version"][..],
        &["-l"][..],
        &["-c"][..],
    ] {
        success(&fixture.run(args, "", &[]).await);
    }
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn tool_call_runs_and_returns_an_api_valid_history() {
    let fixture = Fixture::new(|r| {
        if r.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool")
        {
            let tool = r.body["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(tool["tool_call_id"], "call_1");
            assert!(tool["content"].as_str().unwrap().contains("tool-ok"));
            Reply::chat("done")
        } else {
            Reply::tool("run_cli", json!({"command":"echo tool-ok"}), 10)
        }
    });
    success(&fixture.run(&["-au", "test"], "", &[]).await);
    assert_eq!(fixture.posts().len(), 2);
}

#[tokio::test]
async fn review_denial_does_not_execute_the_command() {
    let fixture = Fixture::new(|r| {
        if r.body["stream"] != true {
            Reply::json(json!({"choices":[{"message":{"role":"assistant","content":"不予放行"}}]}))
        } else if r.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool")
        {
            Reply::chat("done")
        } else {
            Reply::tool(
                "run_cli",
                json!({"command":if cfg!(windows) { "Set-Content should-not-exist x" } else { "touch should-not-exist" }}),
                10,
            )
        }
    });
    success(&fixture.run(&["-u", "test"], "no\n", &[]).await);
    assert!(
        !fixture
            .temp
            .path()
            .join("project/should-not-exist")
            .exists()
    );
    assert_eq!(fixture.posts().len(), 3);
}

#[tokio::test]
async fn retry_happens_before_output_and_not_after_partial_output() {
    let counter = Mutex::new(0);
    let fixture = Fixture::new(move |_| {
        let mut count = counter.lock().unwrap();
        *count += 1;
        if *count == 1 {
            Reply {
                status: 503,
                body: "busy".into(),
                stream: false,
            }
        } else {
            Reply::chat("recovered")
        }
    });
    assert!(success(&fixture.run(&["-u", "test"], "", &[]).await).contains("recovered"));
    assert_eq!(fixture.posts().len(), 2);
    let fixture = Fixture::new(|_| {
        Reply::events(
            vec![json!({"choices":[{"delta":{"content":"partial"}}]})],
            false,
        )
    });
    let output = fixture.run(&["-su", "test"], "", &[]).await;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("不再重试"));
    assert_eq!(fixture.posts().len(), 1);
}

#[tokio::test]
async fn goal_mode_continues_until_marker() {
    let counter = Mutex::new(0);
    let fixture = Fixture::new(move |_| {
        let mut count = counter.lock().unwrap();
        *count += 1;
        Reply::chat(if *count == 1 {
            "continue"
        } else {
            "__TASK_FINISHED__"
        })
    });
    success(&fixture.run(&["-agu", "test"], "", &[]).await);
    assert_eq!(fixture.posts().len(), 2);
}

#[tokio::test]
async fn session_resume_reloads_current_project_hints() {
    let fixture = Fixture::new(|_| Reply::chat("done"));
    success(&fixture.run(&["-asu", "first task"], "", &[]).await);
    std::fs::write(fixture.hint_path(), "NEW_HINT").unwrap();
    success(&fixture.run(&["-asu", "second task"], "", &[]).await);
    let posts = fixture.posts();
    assert!(
        posts[1].body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("NEW_HINT")
    );
    assert!(
        posts[1].body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["content"] == "first task")
    );
    assert!(!fixture.temp.path().join("project/.faye").exists());
}

#[tokio::test]
async fn memory_compaction_updates_prompt_before_continuing() {
    let counter = Mutex::new(0);
    let fixture = Fixture::new(move |r| {
        let mut count = counter.lock().unwrap();
        *count += 1;
        match *count {
            1 => Reply::tool("run_cli", json!({"command":"echo working"}), 90),
            2 => Reply::tool("leave_memory_hints", json!({"hints":"FRESH_HINT"}), 10),
            _ => {
                assert!(
                    r.body["messages"][0]["content"]
                        .as_str()
                        .unwrap()
                        .contains("FRESH_HINT")
                );
                Reply::chat("done")
            }
        }
    });
    fixture.config("chat-completions", 100);
    success(&fixture.run(&["-au", "original task"], "", &[]).await);
    assert_eq!(
        std::fs::read_to_string(fixture.hint_path()).unwrap(),
        "FRESH_HINT"
    );
    assert!(!fixture.temp.path().join("project/.faye").exists());
}

#[tokio::test]
async fn responses_tool_history_preserves_encrypted_reasoning() {
    let fixture = Fixture::new(|r| {
        assert_eq!(r.path, "/v1/responses");
        let has_result = r.body["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "function_call_output");
        if has_result {
            assert!(
                r.body["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["encrypted_content"] == "encrypted-state")
            );
        }
        let output = if has_result {
            vec![
                json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}),
            ]
        } else {
            vec![
                json!({"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-state"}),
                json!({"type":"function_call","id":"fc_1","call_id":"call_1","name":"run_cli","arguments":"{\"command\":\"echo response\"}"}),
            ]
        };
        let mut events = if has_result {
            vec![json!({"type":"response.output_text.delta","delta":"done"})]
        } else {
            vec![
                json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"run_cli","arguments":""}}),
            ]
        };
        events.push(json!({"type":"response.completed","response":{"status":"completed","output":output,"usage":{"input_tokens":10,"output_tokens":5}}}));
        Reply::events(events, false)
    });
    fixture.config("responses", 100000);
    success(&fixture.run(&["-au", "test"], "", &[]).await);
    assert_eq!(fixture.posts().len(), 2);
}

#[tokio::test]
async fn anthropic_tool_history_preserves_signed_thinking() {
    let fixture = Fixture::new(|r| {
        assert_eq!(r.path, "/v1/messages");
        let blocks = r.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|m| m["content"].as_array().unwrap())
            .collect::<Vec<_>>();
        let has_result = blocks.iter().any(|item| item["type"] == "tool_result");
        if has_result {
            assert!(
                blocks
                    .iter()
                    .any(|item| item["signature"] == "signed-state")
            );
        }
        let block = if has_result {
            json!({"type":"text","text":""})
        } else {
            json!({"type":"tool_use","id":"call_1","name":"run_cli","input":{}})
        };
        let delta = if has_result {
            json!({"type":"text_delta","text":"done"})
        } else {
            json!({"type":"input_json_delta","partial_json":"{\"command\":\"echo anthropic\"}"})
        };
        Reply::events(
            vec![
                json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-state"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"content_block_start","index":1,"content_block":block}),
                json!({"type":"content_block_delta","index":1,"delta":delta}),
                json!({"type":"content_block_stop","index":1}),
                json!({"type":"message_delta","usage":{"output_tokens":5}}),
                json!({"type":"message_stop"}),
            ],
            false,
        )
    });
    fixture.config("anthropic", 100000);
    success(&fixture.run(&["-au", "test"], "", &[]).await);
    assert_eq!(fixture.posts().len(), 2);
}
