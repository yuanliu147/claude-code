import { useCallback, useEffect } from 'react'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const handleChange = useCallback(
    (source: SettingSource) => {
		// 缓存已经由通知器重置（changeDetector.fanOut）——
		// 在这里重置会导致 N 个订阅者之间的 N 向抖动：每个
		// 清除缓存，从磁盘重新读取，然后下一个再次清除。
		const newSettings = getSettings_DEPRECATED();
		onChange(source, newSettings);
	},
    [onChange],
  )

  useEffect(
    () => settingsChangeDetector.subscribe(handleChange),
    [handleChange],
  )
}
