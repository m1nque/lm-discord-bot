/**
 * 응답 텍스트를 2000자 제한에 맞게 문단 단위로 분할
 * @param response 분할할 텍스트
 * @param maxLength 최대 길이 (기본값: 2000)
 * @returns 분할된 텍스트 배열
 */
export function splitResponseIntoChunks(response: string, maxLength: number = 2000): string[] {
    // 빈 응답이거나 최대 길이보다 짧은 경우
    if (!response || response.length <= maxLength) {
        return [response];
    }

    const chunks: string[] = [];
    // 문단으로 분할 (빈 줄 기준)
    const paragraphs = response.split(/\n\s*\n/);
    let currentChunk = '';

    for (const paragraph of paragraphs) {
        // 현재 문단 추가 시 길이 계산
        const delimiter = currentChunk.length > 0 ? '\n\n' : '';
        const potentialLength = currentChunk.length + delimiter.length + paragraph.length;

        if (potentialLength > maxLength) {
            // 현재 청크 저장
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = '';
            }

            // 단일 문단이 maxLength를 초과하는 경우
            if (paragraph.length > maxLength) {
                let remainingText = paragraph;

                while (remainingText.length > 0) {
                    if (remainingText.length <= maxLength) {
                        chunks.push(remainingText);
                        break;
                    }

                    // 자연스러운 분할 지점 찾기
                    let splitPoint = findNaturalSplitPoint(remainingText, maxLength);

                    chunks.push(remainingText.substring(0, splitPoint));
                    remainingText = remainingText.substring(splitPoint).trim();
                }
            } else {
                // 한 문단이 maxLength보다 작은 경우 새 청크로 시작
                currentChunk = paragraph;
            }
        } else {
            // 현재 청크에 문단 추가
            if (currentChunk) {
                currentChunk += '\n\n';
            }
            currentChunk += paragraph;
        }
    }

    // 남은 청크 추가
    if (currentChunk) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// 자연스러운 분할 지점 찾기
export function findNaturalSplitPoint(text: string, maxLength: number): number {
    // 문장 끝, 구두점 위치 찾기
    const punctuationPoint = Math.max(
        text.lastIndexOf('. ', maxLength),
        text.lastIndexOf('? ', maxLength),
        text.lastIndexOf('! ', maxLength),
        text.lastIndexOf(', ', maxLength)
    );

    // 문장 단위로 분할 가능한 경우
    if (punctuationPoint > maxLength * 0.7) {
        return punctuationPoint + 2; // 구두점과 공백 포함
    }

    // 공백 위치에서 분할
    const spacePoint = text.lastIndexOf(' ', maxLength);
    if (spacePoint > 0) {
        return spacePoint + 1;
    }

    // 강제 분할
    return maxLength;
}
