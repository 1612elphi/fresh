//! Mouse interaction for per-region scrollbars and panel borders.
//!
//! Handles click, drag, hover, and rendering for scroll regions and
//! border regions declared by virtual buffer plugins.

use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::Frame;

use super::types::{HoverTarget, PanelBorderHitArea, ScrollRegionHitArea};
use crate::view::ui::scrollbar::ScrollbarState;

/// Check if click hits a per-region scrollbar. Returns Some with hit info.
pub(super) fn find_scroll_region_hit(
    scroll_region_areas: &[ScrollRegionHitArea],
    col: u16,
    row: u16,
) -> Option<(&ScrollRegionHitArea, bool)> {
    scroll_region_areas.iter().find_map(|area| {
        let r = &area.scrollbar_rect;
        if col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height {
            let relative_row = row.saturating_sub(r.y) as usize;
            let is_on_thumb = relative_row >= area.thumb_start && relative_row < area.thumb_end;
            Some((area, is_on_thumb))
        } else {
            None
        }
    })
}

/// Check if click hits a panel border. Returns Some with hit info.
pub(super) fn find_border_hit(
    panel_border_areas: &[PanelBorderHitArea],
    col: u16,
    row: u16,
) -> Option<&PanelBorderHitArea> {
    panel_border_areas.iter().find(|border| {
        if border.direction == "v" {
            col == border.x && row >= border.y && row < border.y + border.length
        } else {
            row == border.y && col >= border.x && col < border.x + border.length
        }
    })
}

/// Compute new scroll offset from a click position on the scrollbar track.
/// Reuses `ScrollbarState::click_to_offset()` from scrollbar.rs.
pub(super) fn offset_from_track_click(area: &ScrollRegionHitArea, row: u16) -> usize {
    let sb_state = ScrollbarState::new(area.total_lines, area.visible_lines, area.current_offset);
    let track_height = area.scrollbar_rect.height as usize;
    let click_row = row.saturating_sub(area.scrollbar_rect.y) as usize;
    sb_state.click_to_offset(track_height, click_row)
}

/// Compute new scroll offset during a thumb drag.
pub(super) fn offset_from_thumb_drag(
    area: &ScrollRegionHitArea,
    current_row: u16,
    drag_start_row: u16,
    drag_start_offset: usize,
) -> usize {
    let track_height = area.scrollbar_rect.height as usize;
    if track_height <= 1 || area.total_lines <= area.visible_lines {
        return 0;
    }
    let max_offset = area.total_lines.saturating_sub(area.visible_lines);
    let thumb_size = area.thumb_end.saturating_sub(area.thumb_start).max(1);
    let track_travel = (track_height as f64 - thumb_size as f64).max(1.0);
    let scroll_per_pixel = max_offset as f64 / track_travel;

    let row_delta = current_row as i32 - drag_start_row as i32;
    let offset_delta = (row_delta as f64 * scroll_per_pixel).round() as i64;
    let new_offset = (drag_start_offset as i64 + offset_delta).clamp(0, max_offset as i64);
    new_offset as usize
}

/// Compute hover target for scroll regions and borders.
pub(super) fn compute_hover(
    scroll_region_areas: &[ScrollRegionHitArea],
    panel_border_areas: &[PanelBorderHitArea],
    col: u16,
    row: u16,
) -> Option<HoverTarget> {
    // Check scroll region scrollbars
    if let Some((area, is_on_thumb)) = find_scroll_region_hit(scroll_region_areas, col, row) {
        return if is_on_thumb {
            Some(HoverTarget::ScrollRegionThumb(area.region_id.clone()))
        } else {
            Some(HoverTarget::ScrollRegionTrack(area.region_id.clone()))
        };
    }

    // Check panel borders
    if let Some(border) = find_border_hit(panel_border_areas, col, row) {
        return Some(HoverTarget::PanelBorder(border.border_id.clone()));
    }

    None
}

/// Render hover highlight for scroll region thumb.
pub(super) fn render_scroll_region_thumb_hover(
    frame: &mut Frame,
    scroll_region_areas: &[ScrollRegionHitArea],
    region_id: &str,
    theme: &crate::view::theme::Theme,
) {
    for area in scroll_region_areas {
        if area.region_id == region_id {
            let hover_style = Style::default().bg(theme.scrollbar_thumb_hover_fg);
            for row_offset in area.thumb_start..area.thumb_end {
                let paragraph = Paragraph::new(Span::styled(" ", hover_style));
                frame.render_widget(
                    paragraph,
                    Rect::new(
                        area.scrollbar_rect.x,
                        area.scrollbar_rect.y + row_offset as u16,
                        1,
                        1,
                    ),
                );
            }
            break;
        }
    }
}

/// Render hover highlight for panel border.
pub(super) fn render_panel_border_hover(
    frame: &mut Frame,
    panel_border_areas: &[PanelBorderHitArea],
    border_id: &str,
    theme: &crate::view::theme::Theme,
) {
    for border in panel_border_areas {
        if border.border_id == border_id {
            let hover_style = Style::default().fg(theme.split_separator_hover_fg);
            if border.direction == "v" {
                for offset in 0..border.length {
                    let paragraph = Paragraph::new(Span::styled("│", hover_style));
                    frame.render_widget(paragraph, Rect::new(border.x, border.y + offset, 1, 1));
                }
            } else {
                let line_text = "─".repeat(border.length as usize);
                let paragraph = Paragraph::new(Span::styled(line_text, hover_style));
                frame.render_widget(paragraph, Rect::new(border.x, border.y, border.length, 1));
            }
            break;
        }
    }
}
