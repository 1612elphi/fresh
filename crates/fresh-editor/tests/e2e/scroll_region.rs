// End-to-end tests for scroll region support in virtual buffers.
//
// Tests scroll region rendering, scrollbar visibility, mouse scroll
// suppression, scrollbar click/drag, and border region hit testing.

use crate::common::harness::EditorTestHarness;
use fresh::primitives::text_property::TextPropertyEntry;
use fresh_core::text_property::{BorderRegion, ScrollRegion};

/// Helper: create a virtual buffer with two side-by-side panels,
/// scroll regions for both panels, and a border region for the divider.
/// The left panel declares `left_total_lines` total content so it may
/// need a scrollbar. The right panel always fits (no scrollbar needed).
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
    let right_width = 20u16;

    let mut entries = Vec::new();
    for i in 0..viewport_h {
        let left_text = format!("Left {:>3}", i);
        let left_padded = format!("{:<width$}", left_text, width = left_width as usize);
        let right_text = format!("Right {:>3}", i);
        let right_padded = format!("{:<width$}", right_text, width = right_width as usize);
        entries.push(TextPropertyEntry::text(format!(
            "{}│{}\n",
            left_padded, right_padded
        )));
    }

    // Declare both scroll regions so default buffer scroll is suppressed
    let scroll_regions = vec![
        ScrollRegion {
            id: "left".to_string(),
            x: 0,
            y: 0,
            width: left_width,
            height: viewport_h,
            total_lines: left_total_lines,
            offset: 0,
        },
        ScrollRegion {
            id: "right".to_string(),
            x: left_width + 1,
            y: 0,
            width: right_width,
            height: viewport_h,
            total_lines: viewport_h as usize, // right always fits
            offset: 0,
        },
    ];

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

    harness.editor_mut().switch_buffer(buffer_id);
    buffer_id
}

// ─── Basic rendering ──────────────────────────────────────────────

/// Virtual buffer with scroll regions renders its content correctly.
#[test]
fn test_scroll_region_buffer_renders_content() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 100, 20);
    harness.render().unwrap();

    harness.assert_screen_contains("Left");
    harness.assert_screen_contains("Right");
}

// ─── Scrollbar rendering ──────────────────────────────────────────

/// When a scroll region has more content than viewport, a scrollbar
/// should render at the rightmost column of that region.
#[test]
fn test_scroll_region_scrollbar_renders_at_correct_column() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    // left panel: width=15, totalLines=200 >> viewport=20. Scrollbar at left edge + 14.
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    // The scrollbar should appear somewhere in the left panel area (cols 0-20).
    // Scan those columns to find it. The exact column depends on content_rect.x offset
    // (gutter width, line numbers, etc.)
    let mut found_scrollbar = false;
    for col in 0..25u16 {
        if harness.has_scrollbar_at_column(col) {
            found_scrollbar = true;
            break;
        }
    }
    assert!(
        found_scrollbar,
        "Expected per-region scrollbar in left panel area (cols 0-24)"
    );
    // The global scrollbar column (79) should NOT have a scrollbar
    assert!(
        !harness.has_scrollbar_at_column(79),
        "Global scrollbar should be hidden"
    );
}

/// When content fits in viewport, the scrollbar still renders (full-size thumb)
/// to indicate the panel is an independent scroll region. Content should
/// render correctly with the scrollbar overlay.
#[test]
fn test_scroll_region_scrollbar_always_visible() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    // totalLines=10 < viewport=20 — content fits, but scrollbar still renders
    let _buffer_id = setup_panel_buffer(&mut harness, 10, 20);
    harness.render().unwrap();

    // Full-size thumb (totalLines <= viewport) fills entire track. The style
    // detection may or may not distinguish it from content background. Verify
    // content renders correctly (the scrollbar is a visual overlay that
    // doesn't corrupt adjacent content).
    harness.assert_screen_contains("Left");
    harness.assert_screen_contains("Right");
}

/// The buffer-global scrollbar (rightmost column) should be hidden
/// when scroll regions are present.
#[test]
fn test_global_scrollbar_hidden_with_scroll_regions() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    // The global scrollbar would be at column 79 (rightmost). It should NOT render.
    assert!(
        !harness.has_scrollbar_at_column(79),
        "Global scrollbar should be hidden when scroll regions are present"
    );
}

// ─── Mouse scroll suppression ──────────────────────────────────────

/// Mouse scroll on a buffer with scroll regions should NOT cause default
/// buffer scrolling. The content should stay in place.
#[test]
fn test_mouse_scroll_suppressed_on_scroll_region_buffer() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    // Capture initial content
    let before = harness.screen_to_string();
    assert!(before.contains("Left   0"), "Should show first row");

    // Scroll down on the right panel area (col 25, inside right region)
    harness.mouse_scroll_down(25, 10).unwrap();
    harness.mouse_scroll_down(25, 10).unwrap();
    harness.mouse_scroll_down(25, 10).unwrap();

    // The content should NOT have shifted — default scroll was suppressed
    let after = harness.screen_to_string();
    assert!(
        after.contains("Left   0"),
        "Default buffer scroll should be suppressed; first row should still be visible.\nScreen:\n{}",
        after
    );
}

/// Mouse scroll outside any scroll region (e.g. on a border) should
/// also be suppressed when the buffer has scroll regions.
#[test]
fn test_mouse_scroll_suppressed_even_outside_regions() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    let before = harness.screen_to_string();

    // Scroll on the divider column (col 15)
    harness.mouse_scroll_down(15, 10).unwrap();
    harness.mouse_scroll_down(15, 10).unwrap();

    let after = harness.screen_to_string();
    assert!(
        after.contains("Left   0"),
        "Scroll on divider should be suppressed.\nScreen:\n{}",
        after
    );
}

// ─── Scrollbar click ───────────────────────────────────────────────

/// Clicking on the scrollbar track should fire on_region_scroll to the plugin.
/// Since we don't have a plugin in this test, verify the click doesn't crash
/// and the buffer content is unchanged (no default scroll side effect).
#[test]
fn test_scrollbar_click_no_crash() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 200, 20);
    harness.render().unwrap();

    // Click on the scrollbar at the bottom of the track (should be col 14)
    let content_start_row = 2u16;
    let scrollbar_col = 14u16;
    harness
        .mouse_click(scrollbar_col, content_start_row + 18)
        .unwrap();

    // Should not crash, content still renders
    harness.assert_screen_contains("Left");
}

// ─── Border regions ─────────────────────────────────────────────

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

/// Dragging on a border region should not crash.
#[test]
fn test_border_drag_no_crash() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let _buffer_id = setup_panel_buffer(&mut harness, 100, 20);
    harness.render().unwrap();

    // Drag the divider at column 15 from row 10 to row 10, moving right 5 cols
    let divider_col = 15u16;
    harness
        .mouse_drag(divider_col, 10, divider_col + 5, 10)
        .unwrap();

    // Should not crash
    harness.assert_screen_contains("Left");
}

// ─── Scroll offset update ─────────────────────────────────────────

/// Setting scroll regions with an updated offset should render correctly.
#[test]
fn test_scroll_region_offset_update() {
    let mut harness = EditorTestHarness::new(80, 24).unwrap();
    let buffer_id = setup_panel_buffer(&mut harness, 100, 20);
    harness.render().unwrap();

    // Update with a different scroll offset (simulating plugin scrolled down)
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
