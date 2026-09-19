use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    release_url: String,
    installer_url: Option<String>,
    sha256: Option<String>,
}

#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let release = reqwest::Client::new()
        .get("https://api.github.com/repos/pan2019-maker/RefMind3D/releases/latest")
        .header("User-Agent", "RefMind3D-update-check/1.14.0")
        .send()
        .await
        .map_err(|e| format!("Check update failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Update service returned an error: {e}"))?
        .json::<GithubRelease>()
        .await
        .map_err(|e| format!("Parse update information failed: {e}"))?;
    let installer = release
        .assets
        .iter()
        .find(|asset| asset.name.eq_ignore_ascii_case("RefMind3D_Setup.exe"));
    Ok(UpdateInfo {
        version: release.tag_name.trim_start_matches('v').to_string(),
        release_url: release.html_url,
        installer_url: installer.map(|asset| asset.browser_download_url.clone()),
        sha256: installer
            .and_then(|asset| asset.digest.as_deref())
            .map(|value| value.trim_start_matches("sha256:").to_string()),
    })
}
