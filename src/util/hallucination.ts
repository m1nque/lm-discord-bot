/**
 * 환각 감지 및 응답 검증 유틸리티
 */

/**
 * LLM 응답에서 환각을 감지하고 신뢰도를 평가하는 함수
 * @param contextData - 원본 컨텍스트 데이터
 * @param response - LLM이 생성한 응답
 * @param model - LLM 모델 객체
 * @returns 검증 결과 및 수정된 응답
 */
export async function verifyResponse(
  contextData: any,
  response: string,
  model: any
): Promise<{ 
  isReliable: boolean; 
  verifiedResponse: string; 
  confidenceScore: number;
}> {
  try {
    // 검증을 위한 프롬프트 구성
    const verificationPrompt = `
당신은 AI 응답의 사실 검증을 담당하는 전문가입니다. 

다음은 사용자 질문에 대한 원본 컨텍스트와 AI의 응답입니다:

사용자 질문: "${contextData.question}"

제공된 컨텍스트:
${JSON.stringify(contextData.context, null, 2)}

AI 응답:
"${response}"

이 응답을 다음 기준으로 분석해주세요:
1. 응답이 제공된 컨텍스트에만 기반하는지?
2. 응답에 지어낸 정보나 환각이 있는지?
3. 응답이 사용자 질문에 적절하게 답변하는지?

분석 후 다음 형식으로 응답해주세요:
{
  "isReliable": true/false,
  "confidenceScore": 0-100 (신뢰도 점수),
  "hallucinations": ["환각1", "환각2", ...] (발견된 환각/사실과 다른 내용),
  "recommendation": "수정 권장 사항",
  "improvedResponse": "필요하다면 개선된 응답"
}

JSON 형식으로만 응답해주세요.
`;

    // 검증 요청
    const verificationResponse = await model.respond([
      { role: 'system', content: '당신은 AI 응답의 사실성과 정확성을 검증하는 전문가입니다.' },
      { role: 'user', content: verificationPrompt }
    ], {
      max_tokens: 2000,
      temperature: 0.2, // 낮은 온도로 더 결정적인 응답 유도
    });

    // JSON 응답 파싱
    try {
      const verificationResult = extractJsonFromText(verificationResponse.content);
      
      // 검증 결과에 따라 응답 조정
      if (!verificationResult.isReliable && verificationResult.improvedResponse) {
        return {
          isReliable: false,
          verifiedResponse: verificationResult.improvedResponse,
          confidenceScore: verificationResult.confidenceScore || 0
        };
      }
      
      // 환각이 감지되지 않았거나 개선된 응답이 없는 경우
      return {
        isReliable: verificationResult.isReliable || false,
        verifiedResponse: response, // 원본 응답 유지
        confidenceScore: verificationResult.confidenceScore || 0
      };
    } catch (parseError) {
      console.error('검증 결과 파싱 오류:', parseError);
      // 파싱 오류 시 원본 응답 반환
      return {
        isReliable: false,
        verifiedResponse: response,
        confidenceScore: 0
      };
    }
  } catch (error) {
    console.error('응답 검증 중 오류:', error);
    // 오류 발생 시 원본 응답 반환
    return {
      isReliable: false,
      verifiedResponse: response,
      confidenceScore: 0
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
 * 응답의 신뢰도를 평가하고 필요시 경고 추가
 * @param response - 원본 응답
 * @param confidenceScore - 신뢰도 점수
 * @returns 신뢰도 표시가 추가된 응답
 */
export function addConfidenceDisclaimer(response: string, confidenceScore: number): string {
  // 신뢰도에 따른 면책 문구 추가
  if (confidenceScore < 30) {
    return `⚠️ **낮은 신뢰도 경고**: 이 응답에는 확실하지 않은 정보가 포함되어 있을 수 있습니다.\n\n${response}`;
  } else if (confidenceScore < 70) {
    return `ℹ️ **참고**: 이 응답은 제한된 정보를 기반으로 생성되었습니다.\n\n${response}`;
  }
  
  // 높은 신뢰도는 원본 응답 그대로 반환
  return response;
}
