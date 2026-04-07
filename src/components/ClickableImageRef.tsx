import * as React from 'react'
import { pathToFileURL } from 'url'
import { Link, supportsHyperlinks, Text } from '@anthropic/ink'
import { getStoredImagePath } from '../utils/imageStore.js'
import type { Theme } from '../utils/theme.js'

type Props = {
  imageId: number
  backgroundColor?: keyof Theme
  isSelected?: boolean
}

/**
 * 将图像引用（如 [Image #1]）渲染为可点击链接。
 * 点击时，在默认查看器中打开存储的图像文件。
 *
 * 在以下情况下回退到样式化文本：
 * - 终端不支持超链接
 * - 图像文件在存储中未找到
 */
export function ClickableImageRef({
  imageId,
  backgroundColor,
  isSelected = false,
}: Props): React.ReactNode {
	const imagePath = getStoredImagePath(imageId);
	const displayText = `[Image #${imageId}]`;

	// 如果有存储的图像且终端支持超链接，则使其可点击
	if (imagePath && supportsHyperlinks()) {
		const fileUrl = pathToFileURL(imagePath).href;

		return (
			<Link
				url={fileUrl}
				fallback={
					<Text
						backgroundColor={backgroundColor}
						inverse={isSelected}
					>
						{displayText}
					</Text>
				}
			>
				<Text
					backgroundColor={backgroundColor}
					inverse={isSelected}
					bold={isSelected}
				>
					{displayText}
				</Text>
			</Link>
		);
	}

	// 回退：有样式但不可点击
	return (
		<Text backgroundColor={backgroundColor} inverse={isSelected}>
			{displayText}
		</Text>
	);
}
