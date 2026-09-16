use std::sync::{Mutex, Once, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, Position, Size, WindowEvent};

const PANEL_GAP_LOGICAL_PX: f64 = 8.0;
const SHOW_FOCUS_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskbarEdge {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Debug, Default)]
struct FocusGraceState {
    deadline: Option<Instant>,
}

impl FocusGraceState {
    fn begin(&mut self, now: Instant) {
        self.deadline = Some(now + SHOW_FOCUS_GRACE);
    }

    fn on_focus_event(&mut self, focused: bool, now: Instant) -> bool {
        if focused {
            self.deadline = None;
            return false;
        }
        if self.deadline.is_some_and(|deadline| now < deadline) {
            return false;
        }
        self.deadline = None;
        true
    }
}

fn focus_grace_state() -> &'static Mutex<FocusGraceState> {
    static VALUE: OnceLock<Mutex<FocusGraceState>> = OnceLock::new();
    VALUE.get_or_init(|| Mutex::new(FocusGraceState::default()))
}

fn should_hide_for_focus_event(focused: bool) -> bool {
    focus_grace_state()
        .lock()
        .map(|mut state| state.on_focus_event(focused, Instant::now()))
        .unwrap_or(true)
}

fn begin_focus_grace_period() {
    if let Ok(mut state) = focus_grace_state().lock() {
        state.begin(Instant::now());
    }
}

pub fn init(app_handle: &AppHandle) -> tauri::Result<()> {
    static INIT: Once = Once::new();
    let Some(window) = app_handle.get_webview_window("main") else {
        return Err(tauri::Error::WindowNotFound);
    };

    window.set_skip_taskbar(true)?;
    window.set_always_on_top(true)?;

    #[cfg(target_os = "windows")]
    window.set_shadow(false)?;

    let event_window = window.clone();
    INIT.call_once(move || {
        let hide_window = event_window.clone();
        event_window.on_window_event(move |event| match event {
            WindowEvent::Focused(focused) if should_hide_for_focus_event(*focused) => {
                if let Err(error) = hide_window.hide() {
                    log::error!("failed to hide panel after focus loss: {error}");
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if let Err(error) = hide_window.hide() {
                    log::error!("failed to hide panel after close request: {error}");
                }
            }
            _ => {}
        });
    });

    Ok(())
}

pub fn show_panel(app_handle: &AppHandle) {
    if let Err(error) = init(app_handle) {
        log::error!("failed to initialize standard panel: {error}");
        return;
    }
    position_panel_from_tray(app_handle);
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    begin_focus_grace_period();
    if let Err(error) = window.show() {
        log::error!("failed to show panel: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        log::error!("failed to focus panel: {error}");
    }
}

pub fn hide_panel(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if let Err(error) = window.hide() {
            log::error!("failed to hide panel: {error}");
        }
    }
}

pub fn is_panel_visible(app_handle: &AppHandle) -> bool {
    app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

// Kept as part of the shared panel interface even though Windows tray handling
// currently calls the explicit show/hide functions.
#[allow(dead_code)]
pub fn toggle_panel(app_handle: &AppHandle) {
    if is_panel_visible(app_handle) {
        hide_panel(app_handle);
    } else {
        show_panel(app_handle);
    }
}

pub fn reposition_visible_panel(app_handle: &AppHandle) {
    if is_panel_visible(app_handle) {
        position_panel_from_tray(app_handle);
    }
}

fn position_panel_from_tray(app_handle: &AppHandle) {
    let Some(tray) = app_handle.tray_by_id("tray") else {
        position_panel_fallback(app_handle);
        return;
    };
    match tray.rect() {
        Ok(Some(rect)) => position_panel_at_tray_icon(app_handle, rect.position, rect.size),
        Ok(None) => position_panel_fallback(app_handle),
        Err(error) => {
            log::warn!("failed to read tray rectangle: {error}");
            position_panel_fallback(app_handle);
        }
    }
}

fn physical_rect(position: &Position, size: &Size, scale: f64) -> (f64, f64, f64, f64) {
    let (x, y) = match position {
        Position::Physical(value) => (value.x as f64, value.y as f64),
        Position::Logical(value) => (value.x * scale, value.y * scale),
    };
    let (width, height) = match size {
        Size::Physical(value) => (value.width as f64, value.height as f64),
        Size::Logical(value) => (value.width * scale, value.height * scale),
    };
    (x, y, width, height)
}

fn monitor_contains_point(monitor: &tauri::Monitor, x: f64, y: f64) -> bool {
    let origin = monitor.position();
    let size = monitor.size();
    x >= origin.x as f64
        && x < (origin.x as f64 + size.width as f64)
        && y >= origin.y as f64
        && y < (origin.y as f64 + size.height as f64)
}

fn nearest_taskbar_edge(
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
    icon_x: f64,
    icon_y: f64,
) -> TaskbarEdge {
    let distances = [
        (TaskbarEdge::Top, (icon_y - work_y).abs()),
        (TaskbarEdge::Right, (icon_x - (work_x + work_width)).abs()),
        (TaskbarEdge::Bottom, (icon_y - (work_y + work_height)).abs()),
        (TaskbarEdge::Left, (icon_x - work_x).abs()),
    ];
    distances
        .into_iter()
        .min_by(|left, right| left.1.total_cmp(&right.1))
        .map(|value| value.0)
        .unwrap_or(TaskbarEdge::Bottom)
}

fn taskbar_edge_from_work_area(
    monitor_x: f64,
    monitor_y: f64,
    monitor_width: f64,
    monitor_height: f64,
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
) -> Option<TaskbarEdge> {
    let monitor_right = monitor_x + monitor_width;
    let monitor_bottom = monitor_y + monitor_height;
    let work_right = work_x + work_width;
    let work_bottom = work_y + work_height;
    let insets = [
        (TaskbarEdge::Top, (work_y - monitor_y).max(0.0)),
        (TaskbarEdge::Right, (monitor_right - work_right).max(0.0)),
        (TaskbarEdge::Bottom, (monitor_bottom - work_bottom).max(0.0)),
        (TaskbarEdge::Left, (work_x - monitor_x).max(0.0)),
    ];
    insets
        .into_iter()
        .filter(|(_, inset)| *inset >= 1.0)
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|value| value.0)
}

fn clamped_panel_position(
    edge: TaskbarEdge,
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
    icon_center_x: f64,
    icon_center_y: f64,
    panel_width: f64,
    panel_height: f64,
    gap: f64,
) -> PhysicalPosition<i32> {
    let work_right = work_x + work_width;
    let work_bottom = work_y + work_height;
    let (raw_x, raw_y) = match edge {
        TaskbarEdge::Top => (icon_center_x - panel_width / 2.0, work_y + gap),
        TaskbarEdge::Right => (
            work_right - panel_width - gap,
            icon_center_y - panel_height / 2.0,
        ),
        TaskbarEdge::Bottom => (
            icon_center_x - panel_width / 2.0,
            work_bottom - panel_height - gap,
        ),
        TaskbarEdge::Left => (work_x + gap, icon_center_y - panel_height / 2.0),
    };
    let max_x = (work_right - panel_width).max(work_x);
    let max_y = (work_bottom - panel_height).max(work_y);
    PhysicalPosition::new(
        raw_x.clamp(work_x, max_x).round() as i32,
        raw_y.clamp(work_y, max_y).round() as i32,
    )
}

pub fn position_panel_at_tray_icon(
    app_handle: &AppHandle,
    icon_position: Position,
    icon_size: Size,
) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    let monitors = match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors,
        Ok(_) => return,
        Err(error) => {
            log::warn!("failed to list monitors for panel positioning: {error}");
            return;
        }
    };
    let matched = monitors.iter().find_map(|monitor| {
        let rect = physical_rect(&icon_position, &icon_size, monitor.scale_factor());
        let center = (rect.0 + rect.2 / 2.0, rect.1 + rect.3 / 2.0);
        monitor_contains_point(monitor, center.0, center.1).then(|| (monitor.clone(), center))
    });
    let fallback_monitor = window.primary_monitor().ok().flatten();
    let Some((monitor, (icon_center_x, icon_center_y))) = matched.or_else(|| {
        fallback_monitor.map(|monitor| {
            let rect = physical_rect(&icon_position, &icon_size, monitor.scale_factor());
            let center = (rect.0 + rect.2 / 2.0, rect.1 + rect.3 / 2.0);
            (monitor, center)
        })
    }) else {
        return;
    };
    place_window(&window, &monitor, Some((icon_center_x, icon_center_y)));
}

fn position_panel_fallback(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    log::warn!("tray rectangle unavailable; positioning panel at work-area lower right");
    place_window(&window, &monitor, None);
}

fn place_window(
    window: &tauri::WebviewWindow,
    monitor: &tauri::Monitor,
    icon_center: Option<(f64, f64)>,
) {
    let work = monitor.work_area();
    let panel = match window.outer_size() {
        Ok(size) => size,
        Err(error) => {
            log::warn!("failed to read panel size: {error}");
            return;
        }
    };
    let work_x = work.position.x as f64;
    let work_y = work.position.y as f64;
    let work_width = work.size.width as f64;
    let work_height = work.size.height as f64;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let (icon_x, icon_y, edge) = match icon_center {
        Some((x, y)) => (
            x,
            y,
            taskbar_edge_from_work_area(
                monitor_position.x as f64,
                monitor_position.y as f64,
                monitor_size.width as f64,
                monitor_size.height as f64,
                work_x,
                work_y,
                work_width,
                work_height,
            )
            .unwrap_or_else(|| nearest_taskbar_edge(work_x, work_y, work_width, work_height, x, y)),
        ),
        None => (
            work_x + work_width,
            work_y + work_height,
            TaskbarEdge::Bottom,
        ),
    };
    let position = clamped_panel_position(
        edge,
        work_x,
        work_y,
        work_width,
        work_height,
        icon_x,
        icon_y,
        panel.width as f64,
        panel.height as f64,
        PANEL_GAP_LOGICAL_PX * monitor.scale_factor(),
    );
    if let Err(error) = window.set_position(position) {
        log::error!("failed to position panel: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooses_nearest_work_area_edge() {
        assert_eq!(
            nearest_taskbar_edge(0.0, 0.0, 1920.0, 1040.0, 1800.0, 1070.0),
            TaskbarEdge::Bottom
        );
        assert_eq!(
            nearest_taskbar_edge(40.0, 0.0, 1880.0, 1080.0, 20.0, 500.0),
            TaskbarEdge::Left
        );
    }

    #[test]
    fn clamps_panel_inside_work_area() {
        let position = clamped_panel_position(
            TaskbarEdge::Bottom,
            100.0,
            50.0,
            800.0,
            600.0,
            890.0,
            680.0,
            400.0,
            500.0,
            8.0,
        );
        assert_eq!(position.x, 500);
        assert_eq!(position.y, 142);
    }

    #[test]
    fn focus_grace_ends_as_soon_as_focus_is_obtained() {
        let start = Instant::now();
        let mut state = FocusGraceState::default();
        state.begin(start);

        assert!(!state.on_focus_event(false, start + Duration::from_millis(10)));
        assert!(!state.on_focus_event(true, start + Duration::from_millis(20)));
        assert!(state.on_focus_event(false, start + Duration::from_millis(30)));
    }

    #[test]
    fn detects_each_taskbar_edge_from_work_area_inset() {
        let cases = [
            ((0.0, 40.0, 1920.0, 1040.0), TaskbarEdge::Top),
            ((0.0, 0.0, 1880.0, 1080.0), TaskbarEdge::Right),
            ((0.0, 0.0, 1920.0, 1040.0), TaskbarEdge::Bottom),
            ((40.0, 0.0, 1880.0, 1080.0), TaskbarEdge::Left),
        ];

        for ((work_x, work_y, work_width, work_height), expected) in cases {
            assert_eq!(
                taskbar_edge_from_work_area(
                    0.0,
                    0.0,
                    1920.0,
                    1080.0,
                    work_x,
                    work_y,
                    work_width,
                    work_height,
                ),
                Some(expected)
            );
        }
    }

    #[test]
    fn falls_back_to_icon_distance_when_taskbar_is_auto_hidden() {
        assert_eq!(
            taskbar_edge_from_work_area(0.0, 0.0, 1920.0, 1080.0, 0.0, 0.0, 1920.0, 1080.0),
            None
        );
        assert_eq!(
            nearest_taskbar_edge(0.0, 0.0, 1920.0, 1080.0, 1900.0, 500.0),
            TaskbarEdge::Right
        );
    }
}
