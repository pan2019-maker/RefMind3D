use base64::Engine;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const OLLAMA_DEFAULT_BASE: &str = "http://localhost:11434";
const OLLAMA_BUNDLED_BASE: &str = "http://127.0.0.1:11435";
const OLLAMA_BUNDLED_HOST: &str = "127.0.0.1:11435";
const COMFYUI_DEFAULT_BASE: &str = "http://127.0.0.1:8188";

#[tauri::command]
pub async fn ai_chat(
    api_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    user_message: String,
    context: String,
    image_data_urls: Option<Vec<String>>,
) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("AI model name is empty. Choose a model in AI settings.".to_string());
    }

    let final_user_message = format!(
        "Current RefMind3D selected context:\n{}\n\nUser question:\n{}",
        context.trim(),
        user_message.trim()
    );

    let image_parts: Vec<String> = image_data_urls
        .unwrap_or_default()
        .into_iter()
        .filter(|url| url.starts_with("data:image/"))
        .take(4)
        .collect();

    let system_text = if system_prompt.trim().is_empty() {
        "You are the built-in RefMind3D assistant. Answer directly and help the user analyze reference images, models, documents, spreadsheets, mind maps, and canvas content."
    } else {
        system_prompt.trim()
    };

    let client = reqwest::Client::new();

    if is_ollama_url(&api_url) {
        ensure_ollama_running(&client, &api_url).await?;
        return ai_chat_ollama_native(
            &client,
            &api_url,
            model.trim(),
            system_text,
            &final_user_message,
            image_parts,
        )
        .await;
    }

    let endpoint = normalize_chat_endpoint(&api_url);
    if endpoint.trim().is_empty() {
        return Err(
            "AI API URL is empty. Fill an OpenAI-compatible chat URL in AI settings.".to_string(),
        );
    }

    let user_content = if image_parts.is_empty() {
        Value::String(final_user_message)
    } else {
        let mut parts = vec![json!({ "type": "text", "text": final_user_message })];
        for data_url in image_parts {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": data_url }
            }));
        }
        Value::Array(parts)
    };

    let body = json!({
        "model": model.trim(),
        "messages": [
            { "role": "system", "content": system_text },
            { "role": "user", "content": user_content }
        ],
        "temperature": 0.2
    });

    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&body);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read AI response: {e}"))?;
    if !status.is_success() {
        return Err(format_context_error(status.as_u16(), &text));
    }

    parse_openai_compatible_response(&text)
}

#[tauri::command]
pub async fn ai_generate_image(
    provider: Option<String>,
    api_url: String,
    api_key: String,
    model: String,
    prompt: String,
    reference_image_data_url: Option<String>,
    size: Option<String>,
    quality: Option<String>,
) -> Result<String, String> {
    let mut provider = provider.unwrap_or_else(|| "openai-images".to_string());
    if provider == "local-image-runtime" && !api_url.trim().is_empty() {
        provider = "openai-images".to_string();
    }
    if prompt.trim().is_empty() {
        return Err("Please enter an image generation prompt.".to_string());
    }

    if provider == "local-image-runtime" {
        if model.trim().is_empty() {
            return Err("Local image model is empty. Re-run the offline installer and choose an image model component.".to_string());
        }
        let key = local_image_model_key(&model);
        if key == "zero123plus" {
            return generate_with_zero123plus(reference_image_data_url).await;
        }
        return generate_with_local_comfyui(
            &model,
            &prompt,
            reference_image_data_url,
            size.unwrap_or_else(|| "1024x1024".to_string()),
            quality.unwrap_or_else(|| "standard".to_string()),
        )
        .await;
    }

    if api_url.trim().is_empty() {
        return Err(
            "Image generation API URL is empty. Fill the image API URL in AI settings.".to_string(),
        );
    }
    if model.trim().is_empty() {
        return Err(
            "Image generation model name is empty. Fill the model name in AI settings.".to_string(),
        );
    }
    if is_ollama_url(&api_url) {
        return Err("Ollama vision models can analyze images, but they cannot generate images. Choose Local Image Runtime, OpenAI Images, or Doubao Images.".to_string());
    }

    let client = reqwest::Client::new();
    match provider.as_str() {
        "doubao-images" => {
            generate_with_doubao_images(
                &client,
                &api_url,
                &api_key,
                &model,
                &prompt,
                reference_image_data_url,
                size.unwrap_or_else(|| "2K".to_string()),
                quality.unwrap_or_else(|| "auto".to_string()),
            )
            .await
        }
        _ => {
            generate_with_openai_images(
                &client,
                &api_url,
                &api_key,
                &model,
                &prompt,
                reference_image_data_url,
                size.unwrap_or_else(|| "1024x1024".to_string()),
                quality.unwrap_or_else(|| "standard".to_string()),
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn ai_list_ollama_models(api_url: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    ensure_ollama_running(&client, &api_url).await?;
    fetch_ollama_model_names(&client, &api_url)
        .await
        .map_err(|e| format!("Failed to read Ollama models: {e}"))
}

#[tauri::command]
pub async fn ai_pull_ollama_model(api_url: String, model: String) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("Model name is empty.".to_string());
    }
    let client = reqwest::Client::new();
    ensure_ollama_running(&client, &api_url).await?;
    let base = normalize_ollama_base(&api_url);
    let url = format!("{}/api/pull", base);
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&json!({ "name": model.trim(), "stream": false }))
        .send()
        .await
        .map_err(|e| format!("Ollama model install request failed: {e}. For offline installs, re-run the RefMind3D offline installer and select this model component."))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Ollama install response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Ollama could not install model HTTP {}:\n{}\n\nFor offline installs, re-run the RefMind3D offline installer and select the matching model component.",
            status.as_u16(),
            text
        ));
    }
    Ok(format!("Model installed or updated: {}", model.trim()))
}

#[tauri::command]
pub async fn ai_local_runtime_status(api_url: String) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let ollama_models = match ensure_ollama_running(&client, &api_url).await {
        Ok(()) => fetch_ollama_model_names(&client, &api_url)
            .await
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let comfy_installed = is_comfyui_installed();
    let comfy_ready = if comfy_installed {
        ensure_comfyui_running(&client).await.is_ok()
    } else {
        false
    };
    Ok(json!({
        "ollamaModels": ollama_models,
        "comfyuiReady": comfy_ready,
        "comfyuiInstalled": comfy_installed,
        "comfyuiBaseUrl": COMFYUI_DEFAULT_BASE,
        "installedImageModelIds": installed_image_model_ids()
    }))
}

async fn ai_chat_ollama_native(
    client: &reqwest::Client,
    api_url: &str,
    model: &str,
    system_text: &str,
    final_user_message: &str,
    image_data_urls: Vec<String>,
) -> Result<String, String> {
    let base = normalize_ollama_base(api_url);
    let url = format!("{}/api/chat", base);
    let images = image_data_urls
        .into_iter()
        .filter_map(|data_url| data_url_to_base64(&data_url))
        .collect::<Vec<String>>();

    let user_message = if images.is_empty() {
        json!({ "role": "user", "content": final_user_message })
    } else {
        json!({ "role": "user", "content": final_user_message, "images": images })
    };

    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_text },
            user_message
        ],
        "stream": false,
        "options": {
            "temperature": 0.2,
            "num_ctx": 8192
        }
    });

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Ollama response: {e}"))?;
    if !status.is_success() {
        if status.as_u16() == 404 && text.contains("not_found") {
            let models = fetch_ollama_model_names(client, api_url)
                .await
                .unwrap_or_default();
            let model_list = if models.is_empty() {
                "No local models were found.".to_string()
            } else {
                models.join("\n")
            };
            return Err(format!(
                "Ollama model was not found: {}\n\nRe-run the RefMind3D offline installer and select this model component, or choose an installed model in AI settings.\n\nInstalled models:\n{}\n\nOriginal error:\n{}",
                model, model_list, text
            ));
        }
        return Err(format_context_error(status.as_u16(), &text));
    }

    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Ollama response is not valid JSON: {e}\n\nRaw response:\n{text}"))?;

    if let Some(content) = value
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        return Ok(content.to_string());
    }
    if let Some(content) = value.get("response").and_then(Value::as_str) {
        return Ok(content.to_string());
    }

    Err(format!(
        "Ollama response did not include message.content.\n\nRaw response:\n{text}"
    ))
}

async fn generate_with_zero123plus(
    reference_image_data_url: Option<String>,
) -> Result<String, String> {
    let reference = reference_image_data_url
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Zero123++ needs one selected reference image. Select an image node on the canvas, then generate again.".to_string())?;
    ensure_zero123plus_files()?;
    let (mime, bytes) = data_url_to_bytes(&reference)?;
    let ext = if mime.contains("jpeg") || mime.contains("jpg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "png"
    };
    let temp_dir = env::temp_dir().join("refmind3d-zero123plus");
    fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create Zero123++ temporary folder: {e}"))?;
    let run_id = Uuid::new_v4().to_string();
    let input_path = temp_dir.join(format!("{run_id}-input.{ext}"));
    let output_path = temp_dir.join(format!("{run_id}-output.png"));
    fs::write(&input_path, bytes)
        .map_err(|e| format!("Failed to write Zero123++ reference image: {e}"))?;

    let python = find_comfyui_python()
        .ok_or_else(|| "ComfyUI Portable Python was not found. Re-run the offline installer and choose ComfyUI plus Zero123++.".to_string())?;
    let zero_dir = find_zero123plus_dir()
        .ok_or_else(|| "Zero123++ files were not found. Re-run the offline installer and choose the Zero123++ component.".to_string())?;
    let script = zero_dir.join("refmind_zero123plus.py");
    let model_dir = zero_dir.join("zero123plus-v1.2");
    let pipeline_dir = zero_dir.join("zero123plus-pipeline");

    let input_for_command = input_path.clone();
    let output_for_command = output_path.clone();
    let command_result = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(python);
        command
            .arg(script)
            .arg("--model-dir")
            .arg(model_dir)
            .arg("--pipeline-dir")
            .arg(pipeline_dir)
            .arg("--input")
            .arg(input_for_command)
            .arg("--output")
            .arg(&output_for_command)
            .arg("--steps")
            .arg("18");
        #[cfg(windows)]
        {
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.output()
    })
    .await
    .map_err(|e| format!("Zero123++ task failed to join: {e}"))?
    .map_err(|e| format!("Failed to start Zero123++: {e}"))?;

    let stdout = String::from_utf8_lossy(&command_result.stdout);
    let stderr = String::from_utf8_lossy(&command_result.stderr);
    if !command_result.status.success() {
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&output_path);
        return Err(format!(
            "Zero123++ generation failed.\n\nstdout:\n{}\n\nstderr:\n{}",
            stdout.trim(),
            stderr.trim()
        ));
    }
    let output_bytes = fs::read(&output_path)
        .map_err(|e| format!("Zero123++ finished but output image was not readable: {e}\n\nstdout:\n{}\n\nstderr:\n{}", stdout.trim(), stderr.trim()))?;
    let _ = fs::remove_file(&input_path);
    let _ = fs::remove_file(&output_path);
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output_bytes)
    ))
}

async fn generate_with_local_comfyui(
    model: &str,
    prompt: &str,
    reference_image_data_url: Option<String>,
    size: String,
    _quality: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    ensure_comfyui_running(&client).await?;

    let key = local_image_model_key(model);
    ensure_image_model_files(&key)?;
    let (width, height) = parse_image_size(&size);
    let workflow = if let Some(reference) =
        reference_image_data_url.filter(|value| !value.trim().is_empty())
    {
        let reference_name = upload_comfyui_reference_image(&client, &reference).await?;
        local_image_reference_workflow(&key, prompt, width, height, &reference_name)?
    } else {
        load_comfyui_workflow(&key, prompt, width, height)?
    };
    let client_id = Uuid::new_v4().to_string();
    let response = client
        .post(format!("{}/prompt", COMFYUI_DEFAULT_BASE))
        .header("Content-Type", "application/json")
        .json(&json!({ "prompt": workflow, "client_id": client_id }))
        .send()
        .await
        .map_err(|e| format!("Failed to submit ComfyUI prompt: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read ComfyUI prompt response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "ComfyUI rejected the prompt HTTP {}:\n{}",
            status.as_u16(),
            text
        ));
    }
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        format!("ComfyUI prompt response is not valid JSON: {e}\n\nRaw response:\n{text}")
    })?;
    let prompt_id = value
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI did not return a prompt_id.\n\nRaw response:\n{text}"))?;

    let image = wait_for_comfyui_image(&client, prompt_id).await?;
    fetch_comfyui_image_as_data_url(&client, &image).await
}

async fn wait_for_comfyui_image(
    client: &reqwest::Client,
    prompt_id: &str,
) -> Result<Value, String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(600) {
        let response = client
            .get(format!("{}/history/{}", COMFYUI_DEFAULT_BASE, prompt_id))
            .send()
            .await
            .map_err(|e| format!("Failed to poll ComfyUI history: {e}"))?;
        if response.status().is_success() {
            let value: Value = response
                .json()
                .await
                .map_err(|e| format!("ComfyUI history response is not JSON: {e}"))?;
            if let Some(entry) = value.get(prompt_id) {
                if let Some(error) = entry
                    .get("status")
                    .and_then(|s| s.get("messages"))
                    .and_then(Value::as_array)
                    .and_then(|messages| {
                        messages
                            .iter()
                            .find(|message| message.to_string().contains("execution_error"))
                    })
                {
                    return Err(format!("ComfyUI execution failed:\n{}", error));
                }
                if let Some(outputs) = entry.get("outputs").and_then(Value::as_object) {
                    for output in outputs.values() {
                        if let Some(images) = output.get("images").and_then(Value::as_array) {
                            if let Some(image) = images.first() {
                                return Ok(image.clone());
                            }
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(800));
    }
    Err("ComfyUI image generation timed out. Try a smaller model or lower resolution.".to_string())
}

async fn fetch_comfyui_image_as_data_url(
    client: &reqwest::Client,
    image: &Value,
) -> Result<String, String> {
    let filename = image
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "ComfyUI image response has no filename.".to_string())?;
    let subfolder = image.get("subfolder").and_then(Value::as_str).unwrap_or("");
    let image_type = image
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = client
        .get(format!("{}/view", COMFYUI_DEFAULT_BASE))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", image_type),
        ])
        .send()
        .await
        .map_err(|e| format!("Failed to download ComfyUI image: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Failed to download ComfyUI image HTTP {}",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read ComfyUI image: {e}"))?;
    Ok(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

async fn upload_comfyui_reference_image(
    client: &reqwest::Client,
    data_url: &str,
) -> Result<String, String> {
    let (mime, bytes) = data_url_to_bytes(data_url)?;
    let ext = if mime.contains("jpeg") || mime.contains("jpg") {
        "jpg"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "png"
    };
    let file_name = format!("refmind3d_reference_{}.{}", Uuid::new_v4(), ext);
    let image_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.clone())
        .mime_str(&mime)
        .map_err(|e| format!("Failed to build ComfyUI reference upload: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .part("image", image_part)
        .text("type", "input".to_string())
        .text("overwrite", "true".to_string());
    let response = client
        .post(format!("{}/upload/image", COMFYUI_DEFAULT_BASE))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to upload reference image to ComfyUI: {e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read ComfyUI upload response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "ComfyUI reference image upload failed HTTP {}:\n{}",
            status.as_u16(),
            text
        ));
    }
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
    Ok(value
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&file_name)
        .to_string())
}

fn load_comfyui_workflow(
    model_key: &str,
    prompt: &str,
    width: u32,
    height: u32,
) -> Result<Value, String> {
    if let Some(path) = find_comfyui_dir()
        .map(|dir| {
            dir.join("refmind3d-workflows")
                .join(format!("{model_key}.json"))
        })
        .filter(|p| p.exists())
    {
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read ComfyUI workflow {}: {e}", path.display()))?;
        let replaced = raw
            .replace("{{PROMPT}}", prompt)
            .replace("{{NEGATIVE_PROMPT}}", "low quality, blurry, distorted")
            .replace("{{WIDTH}}", &width.to_string())
            .replace("{{HEIGHT}}", &height.to_string())
            .replace(
                "{{CHECKPOINT_NAME}}",
                &installed_checkpoint_name(model_key)
                    .unwrap_or_else(|| default_checkpoint_name(model_key).to_string()),
            )
            .replace("{{REFMIND_OUTPUT_PREFIX}}", "RefMind3D");
        return serde_json::from_str(&replaced)
            .map_err(|e| format!("ComfyUI workflow JSON is invalid {}: {e}", path.display()));
    }

    if model_key == "flux1-schnell" {
        return Err("FLUX.1-schnell needs its packaged ComfyUI workflow. Re-run the offline installer and select the FLUX component.".to_string());
    }
    let checkpoint = installed_checkpoint_name(model_key)
        .unwrap_or_else(|| default_checkpoint_name(model_key).to_string());
    Ok(basic_checkpoint_workflow(
        prompt,
        width,
        height,
        &checkpoint,
    ))
}

fn local_image_reference_workflow(
    model_key: &str,
    prompt: &str,
    width: u32,
    height: u32,
    reference_name: &str,
) -> Result<Value, String> {
    if model_key == "flux1-schnell" {
        return Err("FLUX.1-schnell reference-image generation needs a dedicated workflow. Choose SD-Turbo or SDXL-Turbo for image-to-image generation.".to_string());
    }
    let checkpoint = installed_checkpoint_name(model_key)
        .unwrap_or_else(|| default_checkpoint_name(model_key).to_string());
    let (steps, cfg, denoise) = match model_key {
        "sdxl-turbo" => (8, 1.8, 0.34),
        "sd35-medium" => (20, 4.0, 0.32),
        _ => (6, 1.5, 0.36),
    };
    Ok(basic_reference_workflow(
        prompt,
        width,
        height,
        &checkpoint,
        reference_name,
        steps,
        cfg,
        denoise,
    ))
}

fn basic_checkpoint_workflow(prompt: &str, width: u32, height: u32, checkpoint: &str) -> Value {
    json!({
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": chrono::Utc::now().timestamp_millis().abs(),
                "steps": 8,
                "cfg": 1.8,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            }
        },
        "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": checkpoint } },
        "5": { "class_type": "EmptyLatentImage", "inputs": { "width": width, "height": height, "batch_size": 1 } },
        "6": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["4", 1] } },
        "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "low quality, blurry, distorted", "clip": ["4", 1] } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
        "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "RefMind3D", "images": ["8", 0] } }
    })
}

fn basic_reference_workflow(
    prompt: &str,
    width: u32,
    height: u32,
    checkpoint: &str,
    reference_name: &str,
    steps: i32,
    cfg: f64,
    denoise: f64,
) -> Value {
    json!({
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": chrono::Utc::now().timestamp_millis().abs(),
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": denoise,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            }
        },
        "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": checkpoint } },
        "5": { "class_type": "VAEEncode", "inputs": { "pixels": ["11", 0], "vae": ["4", 2] } },
        "6": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["4", 1] } },
        "7": { "class_type": "CLIPTextEncode", "inputs": { "text": "low quality, blurry, distorted", "clip": ["4", 1] } },
        "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
        "9": { "class_type": "SaveImage", "inputs": { "filename_prefix": "RefMind3D", "images": ["8", 0] } },
        "10": { "class_type": "LoadImage", "inputs": { "image": reference_name } },
        "11": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["10", 0],
                "upscale_method": "lanczos",
                "width": width,
                "height": height,
                "crop": "center"
            }
        }
    })
}

fn local_image_model_key(model: &str) -> String {
    let normalized = model.replace('\\', "/").to_ascii_lowercase();
    if normalized.contains("zero123") {
        "zero123plus".to_string()
    } else if normalized.contains("sdxl") {
        "sdxl-turbo".to_string()
    } else if normalized.contains("sd35") || normalized.contains("3.5") {
        "sd35-medium".to_string()
    } else if normalized.contains("flux") {
        "flux1-schnell".to_string()
    } else {
        "sd-turbo".to_string()
    }
}

fn default_checkpoint_name(model_key: &str) -> &'static str {
    match model_key {
        "sdxl-turbo" => "sdxl_turbo_1.0_fp16.safetensors",
        "sd35-medium" => "sd3.5_medium.safetensors",
        "flux1-schnell" => "flux1-schnell.safetensors",
        _ => "sd_turbo.safetensors",
    }
}

fn checkpoint_aliases(model_key: &str) -> &'static [&'static str] {
    match model_key {
        "sdxl-turbo" => &[
            "sdxl_turbo_1.0_fp16.safetensors",
            "sdxl-turbo.safetensors",
            "sdxl_turbo.safetensors",
        ],
        "sd35-medium" => &[
            "sd3.5_medium.safetensors",
            "sd35_medium.safetensors",
            "sd3_medium.safetensors",
        ],
        "flux1-schnell" => &["flux1-schnell.safetensors", "flux1_schnell.safetensors"],
        _ => &["sd_turbo.safetensors", "sd-turbo.safetensors"],
    }
}

fn parse_image_size(size: &str) -> (u32, u32) {
    let clean = size.trim().to_ascii_lowercase();
    if clean == "2k" {
        return (1536, 1536);
    }
    if clean == "4k" {
        return (2048, 2048);
    }
    if let Some((w, h)) = clean.split_once('x') {
        let width = w.parse::<u32>().unwrap_or(1024).clamp(512, 2048);
        let height = h.parse::<u32>().unwrap_or(1024).clamp(512, 2048);
        return (width, height);
    }
    (1024, 1024)
}

fn ensure_image_model_files(model_key: &str) -> Result<(), String> {
    if model_key == "zero123plus" {
        return ensure_zero123plus_files();
    }
    let comfy_dir = find_comfyui_dir().ok_or_else(|| "ComfyUI Portable was not found. Re-run the RefMind3D offline installer and choose a local image model component.".to_string())?;
    if installed_checkpoint_name_in_dir(model_key, &comfy_dir).is_some() {
        return Ok(());
    }
    let aliases = checkpoint_aliases(model_key).join(", ");
    Err(format!(
        "Local image model file was not found. Expected one of: {aliases}. Put the checkpoint in ai-runtime\\comfyui\\ComfyUI\\models\\checkpoints, or re-run the offline installer with the matching image model component."
    ))
}

fn installed_checkpoint_name(model_key: &str) -> Option<String> {
    let comfy_dir = find_comfyui_dir()?;
    installed_checkpoint_name_in_dir(model_key, &comfy_dir)
}

fn installed_checkpoint_name_in_dir(model_key: &str, comfy_dir: &Path) -> Option<String> {
    let dirs = [
        comfy_dir.join("ComfyUI").join("models").join("checkpoints"),
        comfy_dir.join("models").join("checkpoints"),
    ];
    for dir in dirs {
        for alias in checkpoint_aliases(model_key) {
            let path = dir.join(alias);
            if path.exists() {
                return Some((*alias).to_string());
            }
        }
    }
    None
}

fn installed_image_model_ids() -> Vec<String> {
    let mut ids = Vec::new();
    for (id, key) in [
        ("sd-turbo-6g", "sd-turbo"),
        ("sdxl-turbo-8g", "sdxl-turbo"),
        ("sd35-medium-12g", "sd35-medium"),
        ("flux1-schnell-12g-plus", "flux1-schnell"),
        ("zero123plus-v12-8g", "zero123plus"),
    ] {
        if ensure_image_model_files(key).is_ok() {
            ids.push(id.to_string());
        }
    }
    ids
}

async fn ensure_ollama_running(client: &reqwest::Client, api_url: &str) -> Result<(), String> {
    if ollama_health(client, api_url).await.is_ok() {
        return Ok(());
    }
    let exe = find_ollama_exe().ok_or_else(|| "Ollama was not found. Re-run the RefMind3D offline installer and select a local vision model component.".to_string())?;
    let mut command = Command::new(exe);
    command.arg("serve");
    if let Some(models_dir) = find_ollama_models_dir() {
        command.env("OLLAMA_MODELS", models_dir);
    }
    if should_use_bundled_ollama(api_url) {
        command.env("OLLAMA_HOST", OLLAMA_BUNDLED_HOST);
    }
    spawn_hidden(command).map_err(|e| format!("Failed to start Ollama silently: {e}"))?;
    wait_for(
        || futures_ollama_probe(client, api_url),
        Duration::from_secs(45),
    )
    .await
    .map_err(|_| {
        "Ollama did not become ready. Re-run the offline installer or start RefMind3D again."
            .to_string()
    })
}

async fn ensure_comfyui_running(client: &reqwest::Client) -> Result<(), String> {
    if comfyui_health(client).await.is_ok() {
        return Ok(());
    }
    let comfy_dir = find_comfyui_dir().ok_or_else(|| "ComfyUI Portable was not found. Re-run the RefMind3D offline installer and choose a local image model component.".to_string())?;
    let bat = comfy_dir.join("run_nvidia_gpu.bat");
    if bat.exists() {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&bat).current_dir(&comfy_dir);
        spawn_hidden(command).map_err(|e| format!("Failed to start ComfyUI silently: {e}"))?;
    } else {
        let python = comfy_dir.join("python_embeded").join("python.exe");
        let main_py = comfy_dir.join("ComfyUI").join("main.py");
        if !python.exists() || !main_py.exists() {
            return Err("ComfyUI Portable files are incomplete. Re-run the RefMind3D offline installer and choose a local image model component.".to_string());
        }
        let mut command = Command::new(python);
        command
            .arg("-s")
            .arg(main_py)
            .arg("--listen")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("8188")
            .arg("--disable-auto-launch")
            .current_dir(comfy_dir.join("ComfyUI"));
        spawn_hidden(command).map_err(|e| format!("Failed to start ComfyUI silently: {e}"))?;
    }
    wait_for(|| futures_comfyui_probe(client), Duration::from_secs(90)).await
        .map_err(|_| "ComfyUI did not become ready. The first startup can be slow; try again or choose a smaller model.".to_string())
}

async fn wait_for<F, Fut>(mut probe: F, timeout: Duration) -> Result<(), ()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<(), ()>>,
{
    let started = Instant::now();
    while started.elapsed() < timeout {
        if probe().await.is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(700));
    }
    Err(())
}

async fn futures_ollama_probe(client: &reqwest::Client, api_url: &str) -> Result<(), ()> {
    ollama_health(client, api_url).await.map_err(|_| ())
}

async fn futures_comfyui_probe(client: &reqwest::Client) -> Result<(), ()> {
    comfyui_health(client).await.map_err(|_| ())
}

async fn ollama_health(client: &reqwest::Client, api_url: &str) -> Result<(), reqwest::Error> {
    client
        .get(format!("{}/api/tags", normalize_ollama_base(api_url)))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn comfyui_health(client: &reqwest::Client) -> Result<(), reqwest::Error> {
    client
        .get(format!("{}/system_stats", COMFYUI_DEFAULT_BASE))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

fn spawn_hidden(mut command: Command) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(|_| ())
}

fn find_ollama_exe() -> Option<PathBuf> {
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("ai-runtime").join("ollama").join("ollama.exe"));
        candidates.push(dir.join("runtimes").join("ollama").join("ollama.exe"));
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Ollama")
                .join("ollama.exe"),
        );
    }
    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(&program_files)
                .join("Ollama")
                .join("ollama.exe"),
        );
        candidates.push(
            PathBuf::from(program_files)
                .join("RefMind3D")
                .join("ai-runtime")
                .join("ollama")
                .join("ollama.exe"),
        );
    }
    candidates.into_iter().find(|p| p.exists())
}

fn find_ollama_models_dir() -> Option<PathBuf> {
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("ai-runtime").join("ollama-models"));
    }
    if let Ok(program_data) = env::var("ProgramData") {
        candidates.push(
            PathBuf::from(program_data)
                .join("RefMind3D")
                .join("ollama-models"),
        );
    }
    candidates.into_iter().find(|p| p.exists())
}

fn find_comfyui_dir() -> Option<PathBuf> {
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("ai-runtime").join("comfyui"));
        candidates.push(dir.join("runtimes").join("comfyui"));
    }
    if let Ok(program_files) = env::var("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("RefMind3D")
                .join("ai-runtime")
                .join("comfyui"),
        );
    }
    candidates.into_iter().find(|p| p.exists())
}

fn find_comfyui_python() -> Option<PathBuf> {
    find_comfyui_dir()
        .map(|dir| dir.join("python_embeded").join("python.exe"))
        .filter(|path| path.exists())
}

fn find_zero123plus_dir() -> Option<PathBuf> {
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("ai-runtime").join("zero123plus"));
    }
    candidates.into_iter().find(|p| p.exists())
}

fn ensure_zero123plus_files() -> Result<(), String> {
    let dir = find_zero123plus_dir()
        .ok_or_else(|| "Zero123++ was not found. Re-run the RefMind3D offline installer and choose the Zero123++ component.".to_string())?;
    let required = [
        dir.join("refmind_zero123plus.py"),
        dir.join("zero123plus-v1.2").join("model_index.json"),
        dir.join("zero123plus-v1.2")
            .join("unet")
            .join("diffusion_pytorch_model.safetensors"),
        dir.join("zero123plus-v1.2")
            .join("vision_encoder")
            .join("model.safetensors"),
        dir.join("zero123plus-pipeline").join("pipeline.py"),
    ];
    if required.iter().all(|path| path.exists()) {
        return Ok(());
    }
    let missing = required
        .iter()
        .filter(|path| !path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "Zero123++ files are incomplete. Re-run the offline installer and choose the Zero123++ component.\n\nMissing:\n{missing}"
    ))
}

fn is_comfyui_installed() -> bool {
    find_comfyui_dir()
        .map(|dir| {
            dir.join("run_nvidia_gpu.bat").exists()
                || (dir.join("python_embeded").join("python.exe").exists()
                    && dir.join("ComfyUI").join("main.py").exists())
        })
        .unwrap_or(false)
}

fn current_exe_dir() -> Option<PathBuf> {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn parse_openai_compatible_response(text: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| format!("AI response is not valid JSON: {e}\n\nRaw response:\n{text}"))?;

    if let Some(content) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        return Ok(content.to_string());
    }
    if let Some(content) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("text"))
        .and_then(Value::as_str)
    {
        return Ok(content.to_string());
    }

    Err(format!(
        "AI response did not include message.content.\n\nRaw response:\n{text}"
    ))
}

fn format_context_error(status: u16, text: &str) -> String {
    if text.contains("exceeds the available context size")
        || text.contains("context") && text.contains("exceed")
    {
        return format!(
            "The AI context exceeded the model limit. Try fewer or smaller images, or choose a model with a larger context window.\n\nOriginal error {}:\n{}",
            status, text
        );
    }
    format!("AI API returned error {}:\n{}", status, text)
}

fn data_url_to_base64(data_url: &str) -> Option<String> {
    data_url
        .split_once(',')
        .map(|(_, encoded)| encoded.to_string())
}

fn is_ollama_url(api_url: &str) -> bool {
    let normalized = api_url.to_ascii_lowercase();
    normalized.contains("localhost:11434")
        || normalized.contains("127.0.0.1:11434")
        || normalized.contains("0.0.0.0:11434")
        || normalized.contains("localhost:11435")
        || normalized.contains("127.0.0.1:11435")
}

fn normalize_ollama_base(api_url: &str) -> String {
    let trimmed = api_url.trim();
    if should_use_bundled_ollama(trimmed) {
        return OLLAMA_BUNDLED_BASE.to_string();
    }
    if trimmed.is_empty() {
        return OLLAMA_DEFAULT_BASE.to_string();
    }
    trimmed
        .trim_end_matches('/')
        .trim_end_matches("/v1/chat/completions")
        .trim_end_matches("/v1")
        .trim_end_matches('/')
        .to_string()
}

fn should_use_bundled_ollama(api_url: &str) -> bool {
    if find_ollama_models_dir().is_none() {
        return false;
    }
    let normalized = api_url.trim().to_ascii_lowercase();
    normalized.is_empty()
        || normalized.contains("localhost:11434")
        || normalized.contains("127.0.0.1:11434")
        || normalized.contains("0.0.0.0:11434")
        || normalized.contains("localhost:11435")
        || normalized.contains("127.0.0.1:11435")
}

async fn generate_with_openai_images(
    client: &reqwest::Client,
    api_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    reference_image_data_url: Option<String>,
    size: String,
    quality: String,
) -> Result<String, String> {
    let has_reference = reference_image_data_url
        .as_ref()
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let endpoint = normalize_openai_image_endpoint(api_url, has_reference);

    let response =
        if let Some(reference) = reference_image_data_url.filter(|v| !v.trim().is_empty()) {
            let (mime, bytes) = data_url_to_bytes(&reference)?;
            let image_part = reqwest::multipart::Part::bytes(bytes)
                .file_name("reference-image.png")
                .mime_str(&mime)
                .map_err(|e| format!("Failed to build reference image upload: {e}"))?;
            let mut form = reqwest::multipart::Form::new()
                .text("model", model.trim().to_string())
                .text("prompt", prompt.trim().to_string())
                .text("size", size)
                .text("response_format", "b64_json".to_string())
                .part("image", image_part);
            if !quality.trim().is_empty() {
                form = form.text("quality", quality);
            }
            let mut request = client.post(endpoint).multipart(form);
            if !api_key.trim().is_empty() {
                request = request.bearer_auth(api_key.trim());
            }
            request
                .send()
                .await
                .map_err(|e| format!("OpenAI image request failed: {e}"))?
        } else {
            let mut body = json!({
                "model": model.trim(),
                "prompt": prompt.trim(),
                "size": size,
                "response_format": "b64_json"
            });
            if !quality.trim().is_empty() {
                body["quality"] = Value::String(quality);
            }
            let mut request = client
                .post(endpoint)
                .header("Content-Type", "application/json")
                .json(&body);
            if !api_key.trim().is_empty() {
                request = request.bearer_auth(api_key.trim());
            }
            request
                .send()
                .await
                .map_err(|e| format!("OpenAI image request failed: {e}"))?
        };

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read OpenAI image response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI image API returned error {}:\n{}",
            status.as_u16(),
            body_text
        ));
    }
    parse_generated_image_response(client, &body_text).await
}

async fn generate_with_doubao_images(
    client: &reqwest::Client,
    api_url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    reference_image_data_url: Option<String>,
    size: String,
    _quality: String,
) -> Result<String, String> {
    let endpoint = normalize_doubao_image_endpoint(api_url);
    let mut body = json!({
        "model": model.trim(),
        "prompt": prompt.trim(),
        "size": size,
        "response_format": "b64_json"
    });
    if let Some(reference) = reference_image_data_url.filter(|v| !v.trim().is_empty()) {
        body["image"] = Value::String(reference);
    }
    let mut request = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .json(&body);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Doubao image request failed: {e}"))?;
    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Doubao image response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Doubao image API returned error {}:\n{}",
            status.as_u16(),
            body_text
        ));
    }
    parse_generated_image_response(client, &body_text).await
}

async fn parse_generated_image_response(
    client: &reqwest::Client,
    text: &str,
) -> Result<String, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| {
        format!("Image generation response is not valid JSON: {e}\n\nRaw response:\n{text}")
    })?;

    if let Some(item) = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    {
        if let Some(data_url) = value_to_image_data_url_or_url(item) {
            return resolve_image_value(client, &data_url).await;
        }
    }
    if let Some(data_url) = value_to_image_data_url_or_url(&value) {
        return resolve_image_value(client, &data_url).await;
    }
    for key in ["result", "image", "images", "urls", "output", "content"] {
        if let Some(found) = search_image_value(value.get(key)) {
            return resolve_image_value(client, &found).await;
        }
    }
    Err(format!(
        "Image generation API did not return usable image data.\n\nRaw response:\n{text}"
    ))
}

fn value_to_image_data_url_or_url(value: &Value) -> Option<String> {
    for key in [
        "b64_json",
        "base64",
        "image_base64",
        "image",
        "url",
        "image_url",
        "link",
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if looks_like_image_value(text) {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn search_image_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) => looks_like_image_value(text).then(|| text.to_string()),
        Value::Array(items) => items.iter().find_map(|item| search_image_value(Some(item))),
        Value::Object(map) => {
            for key in [
                "b64_json",
                "base64",
                "image_base64",
                "image",
                "url",
                "image_url",
                "link",
            ] {
                if let Some(text) = map.get(key).and_then(Value::as_str) {
                    if looks_like_image_value(text) {
                        return Some(text.to_string());
                    }
                }
            }
            map.values().find_map(|item| search_image_value(Some(item)))
        }
        _ => None,
    }
}

fn looks_like_image_value(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("data:image/")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.len() > 512
}

async fn resolve_image_value(client: &reqwest::Client, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.starts_with("data:image/") {
        return Ok(trimmed.to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return fetch_remote_image_as_data_url(client, trimmed).await;
    }
    Ok(format!("data:image/png;base64,{}", trimmed))
}

async fn fetch_remote_image_as_data_url(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download generated image: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Failed to download generated image, HTTP {}",
            status.as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read generated image: {e}"))?;
    Ok(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn data_url_to_bytes(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let (meta, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Reference image data URL is invalid.".to_string())?;
    let mime = meta
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .filter(|s| !s.is_empty())
        .unwrap_or("image/png")
        .to_string();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Failed to decode reference image: {e}"))?;
    Ok((mime, bytes))
}

fn normalize_openai_image_endpoint(api_url: &str, with_reference: bool) -> String {
    let tail = if with_reference {
        "/images/edits"
    } else {
        "/images/generations"
    };
    normalize_image_endpoint_with_tail(api_url, tail)
}

fn normalize_doubao_image_endpoint(api_url: &str) -> String {
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.contains("/images/generations") || trimmed.contains("/images/edits") {
        return trimmed.to_string();
    }
    normalize_image_endpoint_with_tail(trimmed, "/images/generations")
}

fn normalize_image_endpoint_with_tail(api_url: &str, tail: &str) -> String {
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        return format!("{}{}", trimmed.trim_end_matches("/chat/completions"), tail);
    }
    if trimmed.ends_with("/completions") {
        return format!("{}{}", trimmed.trim_end_matches("/completions"), tail);
    }
    if trimmed.ends_with("/v1") || trimmed.ends_with("/v3") {
        return format!("{trimmed}{tail}");
    }
    format!("{trimmed}{tail}")
}

async fn fetch_ollama_model_names(
    client: &reqwest::Client,
    api_url: &str,
) -> Result<Vec<String>, reqwest::Error> {
    let base = normalize_ollama_base(api_url);
    let url = format!("{}/api/tags", base);
    let value: Value = client.get(url).send().await?.json().await?;
    let names = value
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    Ok(names)
}

fn normalize_chat_endpoint(api_url: &str) -> String {
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") || trimmed.ends_with("/v3") {
        format!("{}/chat/completions", trimmed)
    } else {
        format!("{}/v1/chat/completions", trimmed)
    }
}
