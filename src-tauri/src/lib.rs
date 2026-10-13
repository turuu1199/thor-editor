mod commands;
mod compare;
mod connimport;
mod drivers;
mod explain;
mod export;
mod importer;
mod meta;
mod model;
mod oracle_ddl;
mod oracle_env;
mod sessions;
mod sqlparse;
mod ssh;
mod store;
#[cfg(test)]
mod it;
#[cfg(test)]
mod it2;
#[cfg(test)]
mod it3;
#[cfg(test)]
mod it4;

use commands::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            oracle_env::set_resource_dir(app.path().resource_dir().ok());
            let dir = app.path().app_config_dir()?;
            let store = store::ProfileStore::new(dir)?;
            app.manage(AppState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::export_profiles,
            commands::import_profiles,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::execute,
            commands::cancel_query,
            commands::commit,
            commands::rollback,
            commands::set_autocommit,
            commands::set_current_schema,
            commands::release_result,
            commands::list_schemas,
            commands::list_objects,
            commands::table_columns,
            commands::object_ddl,
            commands::graph_edges,
            commands::sql_analyze,
            commands::export_result,
            commands::export_to_string,
            commands::export_query,
            commands::oracle_homes,
            commands::tns_aliases,
            commands::foreign_keys,
            commands::import_preview,
            commands::import_file,
            commands::import_type_names,
            commands::connection_sources,
            commands::parse_connections,
            commands::compare_results,
            commands::write_text_file,
            commands::object_source,
            commands::explain_plan,
            commands::test_session,
            commands::resolve_object,
            commands::session_list,
            commands::session_detail,
            commands::session_kill,
            commands::set_server_output,
            commands::take_server_output,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Thor Editor");
}
