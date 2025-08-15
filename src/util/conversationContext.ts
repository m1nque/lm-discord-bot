import { createClient } from 'redis';

/**
 * Redis 클라이언트를 사용하여 대화 맥락을 관리하는 클래스
 */
export class ConversationContext {
  private client: ReturnType<typeof createClient>;
  private initialized: boolean = false;
  private readonly expirationTime: number = 60 * 60 * 24; // 24시간 (초 단위)
  private readonly maxHistoryLength: number = 10; // 저장할 최대 대화 쌍 수
  
  /**
   * ConversationContext 생성자
   * @param redisUrl - Redis 서버 URL (기본값: localhost:6379)
   */
  constructor(redisUrl: string = 'redis://localhost:6379') {
    this.client = createClient({
      url: redisUrl
    });
    
    this.client.on('error', (err) => {
      console.error('Redis 연결 오류:', err);
    });
  }
  
  /**
   * Redis 클라이언트 연결 초기화
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      try {
        await this.client.connect();
        this.initialized = true;
        console.log('Redis 연결 성공');
      } catch (error) {
        console.error('Redis 연결 실패:', error);
        throw error;
      }
    }
  }
  
  /**
   * Redis 클라이언트 연결 종료
   */
  async disconnect(): Promise<void> {
    if (this.initialized) {
      await this.client.disconnect();
      this.initialized = false;
      console.log('Redis 연결 종료');
    }
  }
  
  /**
   * 스레드 ID에 대한 Redis 키 생성
   * @param threadId - 스레드 ID
   * @param type - 키 유형 (history: 대화 이력, summary: 압축된 맥락)
   * @returns Redis 키
   */
  private getThreadKey(threadId: string, type: 'history' | 'summary'): string {
    return `thread:${threadId}:${type}`;
  }
  
  /**
   * 대화 이력 저장
   * @param threadId - 스레드 ID
   * @param userMessage - 사용자 메시지
   * @param botResponse - 봇 응답
   */
  async saveConversation(
    threadId: string,
    userMessage: string,
    botResponse: string
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const key = this.getThreadKey(threadId, 'history');
    
    try {
      // 현재 저장된 대화 이력 가져오기
      const currentHistory = await this.getConversationHistory(threadId);
      
      // 새 대화 추가
      const newHistory = [
        ...currentHistory,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: botResponse }
      ];
      
      // 최대 길이 제한
      const trimmedHistory = newHistory.slice(-this.maxHistoryLength * 2);
      
      // 대화 이력 저장
      await this.client.set(key, JSON.stringify(trimmedHistory));
      
      // 만료 시간 설정 (24시간)
      await this.client.expire(key, this.expirationTime);
      
      console.log(`스레드 ${threadId}의 대화 이력 저장 완료`);
    } catch (error) {
      console.error(`스레드 ${threadId}의 대화 이력 저장 중 오류:`, error);
    }
  }
  
  /**
   * 압축된 대화 맥락 저장
   * @param threadId - 스레드 ID
   * @param summary - 압축된 대화 맥락 요약
   */
  async saveSummary(threadId: string, summary: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const key = this.getThreadKey(threadId, 'summary');
    
    try {
      // 압축된 맥락 저장
      await this.client.set(key, summary);
      
      // 만료 시간 설정 (24시간)
      await this.client.expire(key, this.expirationTime);
      
      console.log(`스레드 ${threadId}의 압축된 맥락 저장 완료`);
    } catch (error) {
      console.error(`스레드 ${threadId}의 압축된 맥락 저장 중 오류:`, error);
    }
  }
  
  /**
   * 대화 이력 가져오기
   * @param threadId - 스레드 ID
   * @returns 대화 이력 배열
   */
  async getConversationHistory(threadId: string): Promise<Array<{ role: string, content: string }>> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const key = this.getThreadKey(threadId, 'history');
    
    try {
      const history = await this.client.get(key);
      
      if (!history) {
        return [];
      }
      
      return JSON.parse(history);
    } catch (error) {
      console.error(`스레드 ${threadId}의 대화 이력 가져오기 중 오류:`, error);
      return [];
    }
  }
  
  /**
   * 압축된 대화 맥락 가져오기
   * @param threadId - 스레드 ID
   * @returns 압축된 대화 맥락 요약
   */
  async getSummary(threadId: string): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const key = this.getThreadKey(threadId, 'summary');
    
    try {
      const summary = await this.client.get(key);
      return summary || '';
    } catch (error) {
      console.error(`스레드 ${threadId}의 압축된 맥락 가져오기 중 오류:`, error);
      return '';
    }
  }
  
  /**
   * 대화 이력을 바탕으로 압축된 맥락 생성
   * @param threadId - 스레드 ID
   * @param model - LLM 모델 객체
   * @param latestUserMessage - 최신 사용자 메시지
   * @param latestBotResponse - 최신 봇 응답
   * @returns 압축된 대화 맥락
   */
  async generateAndSaveSummary(
    threadId: string, 
    model: any, 
    latestUserMessage: string, 
    latestBotResponse: string
  ): Promise<string> {
    try {
      // 기존 요약 가져오기
      let existingSummary = await this.getSummary(threadId);
      
      // 요약할 내용 구성
      const summaryInput = existingSummary 
        ? `이전 맥락 요약: ${existingSummary}\n\n새로운 대화:\n사용자: ${latestUserMessage}\n봇: ${latestBotResponse}`
        : `대화 요약:\n사용자: ${latestUserMessage}\n봇: ${latestBotResponse}`;
      
      // 요약 프롬프트 구성
      const summaryPrompt = `
다음 대화 내용을 핵심만 간결하게 요약해주세요. 이 요약은 이후 대화에서 맥락을 유지하는 데 사용됩니다.
최대 200단어 이내로 중요한 정보만 포함하세요.

${summaryInput}

간결한 요약:`;
      
      // 모델을 사용하여 요약 생성
      const messages = [
        { role: 'system', content: '당신은 대화 내용을 간결하게 요약하는 전문가입니다. 핵심 정보만 추출하여 압축된 맥락을 생성합니다.' },
        { role: 'user', content: summaryPrompt }
      ];
      
      const prediction = await model.respond(messages, {
        max_tokens: 500,
        temperature: 0.3
      });
      
      const newSummary = prediction.content.trim();
      
      // 새로운 요약 저장
      await this.saveSummary(threadId, newSummary);
      
      console.log(`스레드 ${threadId}의 압축된 맥락 생성 완료`);
      return newSummary;
    } catch (error) {
      console.error(`압축된 맥락 생성 중 오류:`, error);
      return '';
    }
  }
  
  /**
   * 대화 이력 및 압축된 맥락 삭제
   * @param threadId - 스레드 ID
   */
  async clearConversation(threadId: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      const historyKey = this.getThreadKey(threadId, 'history');
      const summaryKey = this.getThreadKey(threadId, 'summary');
      
      await this.client.del(historyKey);
      await this.client.del(summaryKey);
      
      console.log(`스레드 ${threadId}의 대화 정보 삭제 완료`);
    } catch (error) {
      console.error(`스레드 ${threadId}의 대화 정보 삭제 중 오류:`, error);
    }
  }
}

// 싱글톤 인스턴스 생성 및 내보내기
export const conversationContext = new ConversationContext();
