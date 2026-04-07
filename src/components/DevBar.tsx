import * as React from 'react'
import { useState } from 'react'
import { getSlowOperations } from '../bootstrap/state.js'
import { Text, useInterval } from '@anthropic/ink'

// 对开发构建或所有 ant 显示 DevBar
function shouldShowDevBar(): boolean {
  return (
    "production" === 'development' || process.env.USER_TYPE === 'ant'
  )
}

export function DevBar(): React.ReactNode {
	const [slowOps, setSlowOps] = useState<
		ReadonlyArray<{
			operation: string;
			durationMs: number;
			timestamp: number;
		}>
	>(getSlowOperations);

	useInterval(
		() => {
			setSlowOps(getSlowOperations());
		},
		shouldShowDevBar() ? 500 : null,
	);

	// 仅在有内容显示时显示
	if (!shouldShowDevBar() || slowOps.length === 0) {
		return null;
	}

	// Single-line format so short terminals don't lose rows to dev noise.
	const recentOps = slowOps
		.slice(-3)
		.map((op) => `${op.operation} (${Math.round(op.durationMs)}ms)`)
		.join(" · ");

	return (
		<Text wrap="truncate-end" color="warning">
			[ANT-ONLY] slow sync: {recentOps}
		</Text>
	);
}
