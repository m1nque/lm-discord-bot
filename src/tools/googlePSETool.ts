import dotenv from 'dotenv';

dotenv.config();

/**
 * Google Programmable Search Engine(PSE) 도구
 * 나중에 LangChain으로 확장 가능하도록 설계
 */
export class GooglePSETool {
  private apiKey: string;
  private engineId: string;
  private searchCount: string;

  /**
   * GooglePSETool 생성자
   * @param apiKey - Google PSE API 키 (없으면 환경변수에서 로드)
   * @param engineId - Google PSE Engine ID (없으면 환경변수에서 로드)
   * @param searchCount - 검색 결과 수 (없으면 환경변수에서 로드, 기본값 5)
   */
  constructor(
    apiKey?: string,
    engineId?: string,
    searchCount?: string
  ) {
    this.apiKey = apiKey || process.env.GOOGLE_PSE_API_KEY || '';
    this.engineId = engineId || process.env.GOOGLE_PSE_ENGINE_ID || '';
    this.searchCount = searchCount || process.env.GOOGLE_PSE_COUNT || '5';

    if (!this.apiKey || !this.engineId) {
      console.warn('Google PSE API 키 또는 Engine ID가 설정되지 않았습니다.');
    }
  }

  /**
   * 검색 쿼리를 통해 PSE 검색 실행
   * @param query - 검색 쿼리 문자열
   * @returns 검색 결과 배열
   */
  async search(query: string): Promise<any[]> {
    if (!this.apiKey || !this.engineId) {
      console.error('Google PSE API 키 또는 Engine ID가 설정되지 않았습니다.');
      return [];
    }

    try {
      const searchUrl = 'https://www.googleapis.com/customsearch/v1';
      const params = new URLSearchParams({
        key: this.apiKey,
        cx: this.engineId,
        q: query,
        num: this.searchCount
      });
      
      const response = await fetch(`${searchUrl}?${params}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Google PSE API 오류:', errorData);
        return [];
      }
      
      const data = await response.json();
      return data.items || [];
    } catch (error) {
      console.error('Google PSE 검색 중 오류 발생:', error);
      return [];
    }
  }

  /**
   * 검색 결과를 기본 포맷으로 변환
   * @param results - 검색 결과 배열
   * @returns 포맷된 검색 결과 문자열
   */
  formatSearchResults(results: any[]): string {
    if (!results || results.length === 0) {
      return '';
    }

    return results.map((item, index) => 
      `[${index + 1}] ${item.title}\n${item.snippet}\n`
    ).join('\n');
  }

  /**
   * 검색 결과를 요약 프롬프트 형태로 변환
   * @param query - 원본 쿼리 문자열
   * @param results - 검색 결과 배열
   * @returns 요약 프롬프트 문자열
   */
  generateSummaryPrompt(query: string, results: any[]): string {
    const searchContent = this.formatSearchResults(results);
    
    if (!searchContent) {
      return '';
    }
    
    return `
다음 검색 결과를 바탕으로 핵심 내용만 간단히 요약해주세요. 질의와 상관없는 검색 결과는 제외합니다.
${query}

검색 결과:
${searchContent}


요약:`;
  }

  /**
   * PSE 검색을 실행하고 결과를 요약 프롬프트 형태로 반환
   * @param query - 검색 쿼리 문자열
   * @returns 요약 프롬프트 문자열 또는 빈 문자열
   */
  async searchAndGeneratePrompt(query: string): Promise<string> {
    try {
      const results = await this.search(query);
      
      if (!results || results.length === 0) {
        return '';
      }
      
      return this.generateSummaryPrompt(query, results);
    } catch (error) {
      console.error('검색 및 프롬프트 생성 중 오류:', error);
      return '';
    }
  }
}

// 싱글톤 인스턴스 내보내기 (기본 구성으로 사용할 경우)
export const googlePSETool = new GooglePSETool();

// 별도의 함수로 사용하기 편하게 내보내기
export async function performPSESearch(query: string): Promise<any[]> {
  return googlePSETool.search(query);
}

// 검색 결과 요약 프롬프트 생성 함수
export async function generatePSESummaryPrompt(query: string): Promise<string> {
  const results = await googlePSETool.search(query);
  return googlePSETool.generateSummaryPrompt(query, results);
}
