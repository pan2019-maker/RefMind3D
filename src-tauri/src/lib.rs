mod commands;
mod runtime_assets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("refmind3d", |_ctx, request| {
            runtime_assets::protocol_response(request)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_chat,
            commands::ai::ai_generate_image,
            commands::ai::ai_list_ollama_models,
            commands::ai::ai_local_runtime_status,
            commands::ai::ai_pull_ollama_model,
            commands::image::import_image_asset,
            commands::image::import_clipboard_image_data_url,
            commands::image::import_remote_image_asset,
            commands::image::register_runtime_asset,
            commands::image::image_asset_to_data_url,
            commands::image::copy_image_asset_to_clipboard,
            commands::cache::image_cache_status,
            commands::cache::set_image_cache_directory,
            commands::cache::migrate_image_cache,
            commands::cache::confirm_default_image_cache_directory,
            commands::cache::clear_image_cache,
            commands::cache::prepare_image_cache,
            commands::cache::load_model_cover,
            commands::cache::save_model_cover,
            commands::document::import_document_asset,
            commands::document::register_runtime_document_asset,
            commands::video::import_video_asset,
            commands::video::register_runtime_video_asset,
            commands::document::export_editable_document_asset,
            commands::model::inspect_model_asset,
            commands::model::register_runtime_model_asset,
            commands::model::convert_model_to_obj,
            commands::project::save_project,
            commands::project::save_recovery_project,
            commands::project::load_newer_recovery_project,
            commands::project::clear_recovery_project,
            commands::project::force_close_window,
            commands::project::load_project,
            commands::project::get_launch_project_path,
            commands::project::load_project_data_url,
            commands::project::save_png_data_url,
            commands::project::save_data_url_to_path,
            commands::project::copy_file_to_path,
            commands::project::export_files_to_folder,
            commands::window::set_window_opacity
        ])
        .run(tauri::generate_context!())
        .expect("error while running RefMind3D");
}
