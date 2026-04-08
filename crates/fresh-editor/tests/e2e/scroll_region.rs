// End-to-end tests for scroll region support in virtual buffers.
//
// Tests that virtual buffers with scroll regions render correctly
// and that the content is properly viewport-clamped.

use crate::common::harness::EditorTestHarness;
use fresh::primitives::text_property::TextPropertyEntry;
use fresh_core::text_property::{BorderRegion, ScrollRegion};

/// Helper: create a virtual buffer with two side-by-side panels separated
/// by a divider, with scroll regions and border regions declared.
fn setup_panel_buffer(
    harness: &mut EditorTestHarness,
    left_total_lines: usize,
    viewport_h: u16,
) -> fresh::model::event::BufferId {
    let buffer_id = harness.editor_mut().create_virtual_buffer(
        "*PanelTest*".to_string(),
        "text".to_string(),
        true,
    );

    let left_width = 15u16;

    // Build content: viewport_h rows of "LeftNN │RightNN"
    let mut entries = Vec::new();
    for i in 0..viewport_h {
        let left_text = format!("Left {:>3}", i);
        let left_padded = format!("{:<width$}", left_text, width = left_width as usize);
        entries.push(TextPropertyEntry::text(format!(
            "{}│Right {:>3}\n",
            left_padded, i
        )));
    }

    let scroll_regions = vec![ScrollRegion {
        id: "left".to_string(),
        x: 0,
        y: 0,
        width: left_width,
        height: viewport_h,
        total_lines: left_total_lines,
        offset: 0,
    }];

    let border_regions = vec![BorderRegion {
        id: "divider".to_string(),
        x: left_width,
        y: 0,
        length: viewport_h,
        direction: "v".to_string(),
    }];

    harness
        .editor_mut()
        .set_virtual_buffer_content(buffer_id, entries, scroll_regions, border_regions)
        .unwrap();

    // Switch to the buffer to make it visible
    harness.editor_mut().switch_buffer(buffer_id);

    buffer_id
}

/// Virtual buffer with scroll regions renders its content correctly.
#[test]
fn test_scroll_region_buffer_renders_content() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 100, 20);
    harness.render().unwrap();

    harness.assert_screen_contains("Left");
    harness.assert_screen_contains("Right");
}

/// Virtual buffer with scroll regions where content fits should still render.
#[test]
fn test_scroll_region_no_scrollbar_when_fits() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 10, 20);
    harness.render().unwrap();

    harness.assert_screen_contains("Left");
    harness.assert_screen_contains("Right");
}

/// Scroll regions with more content than viewport should render without errors.
#[test]
fn test_scroll_region_with_scrollbar() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    harness.assert_screen_contains("Left");
}

/// Border regions should be accepted and render without errors.
#[test]
fn test_border_region_accepted() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();

    let buffer_id = harness.editor_mut().create_virtual_buffer(
        "*BorderTest*".to_string(),
        "text".to_string(),
        true,
    );

    let mut entries = Vec::new();
    for i in 0..20u16 {
        entries.push(TextPropertyEntry::text(format!("Content {:>3}\n", i)));
    }

    let border_regions = vec![BorderRegion {
        id: "divider".to_string(),
        x: 10,
        y: 0,
        length: 20,
        direction: "v".to_string(),
    }];

    harness
        .editor_mut()
        .set_virtual_buffer_content(buffer_id, entries, Vec::new(), border_regions)
        .unwrap();

    harness.editor_mut().switch_buffer(buffer_id);
    harness.render().unwrap();

    harness.assert_screen_contains("Content");
}

/// Setting scroll regions with updated offset should not error.
#[test]
fn test_scroll_region_offset_update() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let buffer_id = setup_panel_buffer(&mut harness, 100, 20);
    harness.render().unwrap();

    // Update with a different scroll offset (simulating user scrolled down)
    let mut entries = Vec::new();
    for i in 10..30u16 {
        entries.push(TextPropertyEntry::text(format!("Line {:>3}\n", i)));
    }

    let scroll_regions = vec![ScrollRegion {
        id: "left".to_string(),
        x: 0,
        y: 0,
        width: 15,
        height: 20,
        total_lines: 100,
        offset: 10,
    }];

    harness
        .editor_mut()
        .set_virtual_buffer_content(buffer_id, entries, scroll_regions, Vec::new())
        .unwrap();

    harness.render().unwrap();
    harness.assert_screen_contains("Line");
}
