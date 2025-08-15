/**
 * 대화 주제 변경 감지 및 컨텍스트 분리 유틸리티
 */

import { LMStudioClient } from '@lmstudio/sdk';

/**
 * 새 질문이 이전 대화와 주제가 변경되었는지 감지
 * @param prevQuestion - 이전 질문
 * @param prevResponse - 이전 응답
 * @param newQuestion - 새 질문
 * @param model - LLM 모델
 * @returns 주제 변경 여부 및 분석 결과
 */
export async function detectTopicChange(
  prevQuestion: string,
  prevResponse: string,
  newQuestion: string,
  model: any
): Promise<{
  isNewTopic: boolean;
  similarity: number;
  analysis: string;
  shouldResetContext: boolean;
}> {
  try {
    // 주제 변경 감지 프롬프트
    const prompt = `
이전 대화:
사용자: ${prevQuestion}
봇: ${prevResponse}

새로운 질문:
사용자: ${newQuestion}

위 대화를 분석하여 새로운 질문이 이전 대화와 동일한 주제인지 다른 주제인지 판단해주세요.
완전히 다른 주제라면 이전 대화 컨텍스트를 초기화해야 합니다.

다음 형식으로 응답해주세요:
{
  "isNewTopic": true/false (새로운 주제이면 true),
  "similarity": 0-100 (주제 유사도 점수, 100이 완전 동일),
  "analysis": "주제 관계에 대한 간략한 분석",
  "shouldResetContext": true/false (컨텍스트 초기화가 필요하면 true)
}

JSON 형식으로만 응답해주세요.
`;

    // 주제 변경 분석 요청
    const analysisResponse = await model.respond([
      { role: 'system', content: '당신은 대화 주제의 연속성과 관련성을 분석하는 전문가입니다.' },
      { role: 'user', content: prompt }
    ], {
      max_tokens: 1000,
      temperature: 0.2
    });

    // JSON 응답 파싱
    try {
      const result = extractJsonFromText(analysisResponse.content);
      return {
        isNewTopic: result.isNewTopic || false,
        similarity: result.similarity || 0,
        analysis: result.analysis || '',
        shouldResetContext: result.shouldResetContext || false
      };
    } catch (parseError) {
      console.error('주제 변경 분석 결과 파싱 오류:', parseError);
      return {
        isNewTopic: false,
        similarity: 50, // 기본값
        analysis: '분석 실패',
        shouldResetContext: false
      };
    }
  } catch (error) {
    console.error('주제 변경 감지 중 오류:', error);
    return {
      isNewTopic: false,
      similarity: 50, // 기본값
      analysis: '오류 발생',
      shouldResetContext: false
    };
  }
}

/**
 * 문맥 오염(context contamination) 감지
 * @param prevQuestion - 이전 질문
 * @param prevResponse - 이전 응답
 * @param newQuestion - 새 질문
 * @param proposedResponse - 생성된 응답
 * @param model - LLM 모델
 * @returns 오염 감지 결과
 */
export async function detectContextContamination(
  prevQuestion: string,
  prevResponse: string,
  newQuestion: string,
  proposedResponse: string,
  model: any
): Promise<{
  isContaminated: boolean;
  contaminationScore: number;
  cleanedResponse?: string;
}> {
  try {
    // 문맥 오염 감지 프롬프트
    const prompt = `
이전 대화:
사용자: ${prevQuestion}
봇: ${prevResponse}

현재 대화:
사용자: ${newQuestion}
봇(생성된 응답): ${proposedResponse}

위 대화에서 문맥 오염(context contamination)을 분석해주세요. 
문맥 오염이란 이전 대화의 내용이 현재 대화에 부적절하게 영향을 미치는 현상입니다.

다음을 확인해주세요:
1. 새 응답이 이전 대화의 주제나 내용을 부적절하게 계속하고 있는지?
2. 새 질문과 무관한 이전 대화의 세부 정보가 응답에 포함되어 있는지?
3. 새 응답이 이전 대화를 전제로 하여 새 질문에 직접 관련 없는 내용을 언급하는지?

다음 형식으로 응답해주세요:
{
  "isContaminated": true/false (문맥 오염이 감지되면 true),
  "contaminationScore": 0-100 (오염 정도 점수, 100이 완전 오염),
  "contaminatedSegments": ["오염된 부분1", "오염된 부분2", ...],
  "explanation": "오염 분석 설명",
  "cleanedResponse": "오염을 제거한 개선된 응답"
}

JSON 형식으로만 응답해주세요.
`;

    // 문맥 오염 분석 요청
    const analysisResponse = await model.respond([
      { role: 'system', content: '당신은 대화에서 문맥 오염(context contamination)을 감지하고 수정하는 전문가입니다.' },
      { role: 'user', content: prompt }
    ], {
      max_tokens: 2000,
      temperature: 0.2
    });

    // JSON 응답 파싱
    try {
      const result = extractJsonFromText(analysisResponse.content);
      return {
        isContaminated: result.isContaminated || false,
        contaminationScore: result.contaminationScore || 0,
        cleanedResponse: result.cleanedResponse || proposedResponse
      };
    } catch (parseError) {
      console.error('문맥 오염 분석 결과 파싱 오류:', parseError);
      return {
        isContaminated: false,
        contaminationScore: 0,
        cleanedResponse: proposedResponse
      };
    }
  } catch (error) {
    console.error('문맥 오염 감지 중 오류:', error);
    return {
      isContaminated: false,
      contaminationScore: 0
    };
  }
}

/**
 * 텍스트에서 JSON 객체 추출
 * @param text - JSON을 포함한 텍스트
 * @returns 파싱된 JSON 객체
 */
function extractJsonFromText(text: string): any {
  // JSON 형식 추출을 위한 정규식
  const jsonRegex = /{[\s\S]*}/;
  const match = text.match(jsonRegex);
  
  if (match && match[0]) {
    try {
      return JSON.parse(match[0]);
    } catch (error) {
      console.error('JSON 파싱 오류:', error);
      throw new Error('JSON 형식이 아닙니다');
    }
  }
  
  throw new Error('텍스트에서 JSON을 찾을 수 없습니다');
}

/**
 * 컨텍스트 초기화가 필요한지 판단
 * @param similarity - 주제 유사도 점수
 * @param contaminationScore - 문맥 오염 점수
 * @returns 초기화 여부
 */
export function shouldResetContext(similarity: number, contaminationScore: number): boolean {
  // 주제 유사도가 낮거나 문맥 오염이 심한 경우 컨텍스트 초기화
  return similarity < 30 || contaminationScore > 70;
}

/**
 * 문맥 오염 감지 결과에 따른 경고 메시지 추가
 * @param response - 원본 응답
 * @param contaminationScore - 오염 점수
 * @returns 경고가 추가된 응답
 */
export function addContaminationWarning(response: string, contaminationScore: number): string {
  if (contaminationScore > 70) {
    return `⚠️ **주의**: 이전 대화의 내용이 현재 응답에 영향을 미칠 수 있습니다.\n\n${response}`;
  } else if (contaminationScore > 30) {
    return `ℹ️ **참고**: 이 응답은 부분적으로 이전 대화의 맥락을 포함하고 있습니다.\n\n${response}`;
  }
  
  return response;
}
