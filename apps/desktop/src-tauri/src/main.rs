#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tapd_client_lib::run();
}
