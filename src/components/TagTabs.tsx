import React from 'react'
import { Box, Text, stringWidth } from '@anthropic/ink'
import { truncateToWidth } from '../utils/format.js'

// 用于宽度计算的常量 — 派生自实际渲染的字符串
const ALL_TAB_LABEL = 'All'
const TAB_PADDING = 2 // Space before and after tab text: " {tab} "
const HASH_PREFIX_LENGTH = 1 // "#" prefix for non-All tabs
const LEFT_ARROW_PREFIX = '← '
const RIGHT_HINT_WITH_COUNT_PREFIX = '→'
const RIGHT_HINT_SUFFIX = ' (tab to cycle)'
const RIGHT_HINT_NO_COUNT = '(tab to cycle)'
const MAX_OVERFLOW_DIGITS = 2 // Assume max 99 hidden tabs for width calculation

// 计算宽度
const LEFT_ARROW_WIDTH = LEFT_ARROW_PREFIX.length + MAX_OVERFLOW_DIGITS + 1 // "← NN " with gap
const RIGHT_HINT_WIDTH_WITH_COUNT =
  RIGHT_HINT_WITH_COUNT_PREFIX.length +
  MAX_OVERFLOW_DIGITS +
  RIGHT_HINT_SUFFIX.length // "→NN (tab to cycle)"
const RIGHT_HINT_WIDTH_NO_COUNT = RIGHT_HINT_NO_COUNT.length

type Props = {
  tabs: string[]
  selectedIndex: number
  availableWidth: number
  showAllProjects?: boolean
}

/**
 * Calculate the display width of a tab
 */
function getTabWidth(tab: string, maxWidth?: number): number {
  if (tab === ALL_TAB_LABEL) {
    return ALL_TAB_LABEL.length + TAB_PADDING
  }
  // 对于非 All 标签：" #{tag} " 但需要时截断标签
  const tagWidth = stringWidth(tab)
  const effectiveTagWidth = maxWidth
    ? Math.min(tagWidth, maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH)
    : tagWidth
  return Math.max(0, effectiveTagWidth) + TAB_PADDING + HASH_PREFIX_LENGTH
}

/**
 * Truncate a tag to fit within maxWidth, accounting for padding and hash prefix
 */
function truncateTag(tag: string, maxWidth: number): string {
  // 标签文本本身可用的空间：maxWidth - " #" - " "
  const availableForTag = maxWidth - TAB_PADDING - HASH_PREFIX_LENGTH
  if (stringWidth(tag) <= availableForTag) {
    return tag
  }
  if (availableForTag <= 1) {
    return tag.charAt(0)
  }
  return truncateToWidth(tag, availableForTag)
}

export function TagTabs({
  tabs,
  selectedIndex,
  availableWidth,
  showAllProjects = false,
}: Props): React.ReactNode {
  const resumeLabel = showAllProjects ? 'Resume (All Projects)' : 'Resume'
  const resumeLabelWidth = resumeLabel.length + 1 // +1 for gap

  // 计算标签的空间（使用最坏情况提示宽度）
  const rightHintWidth = Math.max(
    RIGHT_HINT_WIDTH_WITH_COUNT,
    RIGHT_HINT_WIDTH_NO_COUNT,
  )
  const maxTabsWidth = availableWidth - resumeLabelWidth - rightHintWidth - 2 // 2 for gaps

  // 将 selectedIndex 箝位到有效范围
  const safeSelectedIndex = Math.max(
    0,
    Math.min(selectedIndex, tabs.length - 1),
  )

  // 计算每个标签的宽度，对于非常长的标签进行截断
  const maxSingleTabWidth = Math.max(20, Math.floor(maxTabsWidth / 2)) // At least show half the space for one tab
  const tabWidths = tabs.map(tab => getTabWidth(tab, maxSingleTabWidth))

  // 找到适合的标签窗口，以 selectedIndex 为中心
  let startIndex = 0
  let endIndex = tabs.length

  // 计算所有标签的总宽度
  const totalTabsWidth = tabWidths.reduce(
    (sum, w, i) => sum + w + (i < tabWidths.length - 1 ? 1 : 0),
    0,
  ) // +1 for gaps between tabs

  if (totalTabsWidth > maxTabsWidth) {
    // Need to show a subset - account for left arrow when not at start
    const effectiveMaxWidth = maxTabsWidth - LEFT_ARROW_WIDTH

    // Start with the selected tab
    let windowWidth = tabWidths[safeSelectedIndex] ?? 0
    startIndex = safeSelectedIndex
    endIndex = safeSelectedIndex + 1

    // Expand window to include more tabs
    while (startIndex > 0 || endIndex < tabs.length) {
      const canExpandLeft = startIndex > 0
      const canExpandRight = endIndex < tabs.length

      if (canExpandLeft) {
        const leftWidth = (tabWidths[startIndex - 1] ?? 0) + 1 // +1 for gap
        if (windowWidth + leftWidth <= effectiveMaxWidth) {
          startIndex--
          windowWidth += leftWidth
          continue
        }
      }

      if (canExpandRight) {
        const rightWidth = (tabWidths[endIndex] ?? 0) + 1 // +1 for gap
        if (windowWidth + rightWidth <= effectiveMaxWidth) {
          endIndex++
          windowWidth += rightWidth
          continue
        }
      }

      break
    }
  }

  const hiddenLeft = startIndex
  const hiddenRight = tabs.length - endIndex
  const visibleTabs = tabs.slice(startIndex, endIndex)
  const visibleIndices = visibleTabs.map((_, i) => startIndex + i)

  return (
    <Box flexDirection="row" gap={1}>
      <Text color="suggestion">{resumeLabel}</Text>
      {hiddenLeft > 0 && (
        <Text dimColor>
          {LEFT_ARROW_PREFIX}
          {hiddenLeft}
        </Text>
      )}
      {visibleTabs.map((tab, i) => {
        const actualIndex = visibleIndices[i]!
        const isSelected = actualIndex === safeSelectedIndex
        const displayText =
          tab === ALL_TAB_LABEL
            ? tab
            : `#${truncateTag(tab, maxSingleTabWidth - TAB_PADDING)}`
        return (
          <Text
            key={tab}
            backgroundColor={isSelected ? 'suggestion' : undefined}
            color={isSelected ? 'inverseText' : undefined}
            bold={isSelected}
          >
            {' '}
            {displayText}{' '}
          </Text>
        )
      })}
      {hiddenRight > 0 ? (
        <Text dimColor>
          {RIGHT_HINT_WITH_COUNT_PREFIX}
          {hiddenRight}
          {RIGHT_HINT_SUFFIX}
        </Text>
      ) : (
        <Text dimColor>{RIGHT_HINT_NO_COUNT}</Text>
      )}
    </Box>
  )
}
