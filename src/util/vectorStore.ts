import { ChromaClient, Collection } from 'chromadb';
import dotenv from 'dotenv';
// OpenAI 제거하고 LM Studio 관련 모듈 임포트
import { LMStudioClient } from '@lmstudio/sdk';
// Chroma의 기본 임베딩 함수 임포트
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';

// 환경 변수 로드
dotenv.config();

/**
 * Chroma 벡터 DB를 사용하여 대화 임베딩을 관리하는 클래스
 */
export class VectorStore {
  private client: ChromaClient;
  private collection: Collection | null = null;
  private initialized: boolean = false;
  private lmStudioClient: LMStudioClient;
  private readonly collectionName: string = 'discord_conversations';
  private embeddingModel: any = null;
  private embeddingFunction: DefaultEmbeddingFunction;
  
  /**
   * VectorStore 생성자
   */
  constructor() {
    const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8000';
    
    this.client = new ChromaClient({
      path: chromaUrl
    });
    
    // 기본 임베딩 함수 초기화
    this.embeddingFunction = new DefaultEmbeddingFunction();
    
    // LM Studio 클라이언트 초기화
    this.lmStudioClient = new LMStudioClient();
  }
  
  /**
   * 벡터 저장소 초기화
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      try {
        // 컬렉션 생성 또는 가져오기 (기본 임베딩 함수 사용)
        this.collection = await this.client.getOrCreateCollection({
          name: this.collectionName,
          metadata: {
            description: '디스코드 봇 대화 저장소'
          },
          embeddingFunction: this.embeddingFunction
        });
        
        // LM Studio 모델 로드
        const loadedModels = await this.lmStudioClient.llm.listLoaded();
        if (loadedModels.length === 0) {
          throw new Error('로드된 모델이 없습니다. LM Studio에서 모델을 먼저 로드해주세요.');
        }
        
        this.embeddingModel = loadedModels[0];
        
        this.initialized = true;
        console.log('Chroma DB 연결 및 임베딩 모델 초기화 성공');
      } catch (error) {
        console.error('Chroma DB 연결 또는 임베딩 모델 초기화 실패:', error);
        throw error;
      }
    }
  }
  
  /**
   * 텍스트 임베딩 생성 (로컬 LLM 활용)
   * @param text - 임베딩할 텍스트
   * @returns 임베딩 벡터
   */
  private async getEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingModel) {
      throw new Error('임베딩 모델이 초기화되지 않았습니다.');
    }
    
    try {
      // 임베딩 생성을 위한 프롬프트
      const embeddingPrompt = `
다음 텍스트를 임베딩 벡터로 변환해 주세요. 응답은 JSON 배열 형태로 제공해주세요:

텍스트: "${text}"

임베딩 벡터 (JSON 배열):`;
      
      // LM Studio 모델을 사용하여 임베딩 생성
      const response = await this.embeddingModel.respond([
        { role: 'system', content: '당신은 텍스트를 의미적 임베딩 벡터로 변환하는 도구입니다. 결과는 항상 숫자 배열 형태로 제공합니다.' },
        { role: 'user', content: embeddingPrompt }
      ], {
        max_tokens: 2048,
        temperature: 0.1
      });
      
      // 응답에서 JSON 배열 추출
      try {
        const jsonContent = response.content.trim();
        const startIdx = jsonContent.indexOf('[');
        const endIdx = jsonContent.lastIndexOf(']') + 1;
        
        if (startIdx >= 0 && endIdx > startIdx) {
          const jsonArray = jsonContent.substring(startIdx, endIdx);
          const embedding = JSON.parse(jsonArray);
          
          // 배열 길이 정규화 (고정 길이로 조정)
          const VECTOR_SIZE = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '384');
          const normalizedEmbedding = this.normalizeEmbeddingSize(embedding, VECTOR_SIZE);
          
          return normalizedEmbedding;
        }
        
        throw new Error('유효한 임베딩 배열을 추출할 수 없습니다.');
      } catch (parseError) {
        console.error('임베딩 응답 파싱 실패:', parseError);
        // 실패 시 랜덤 임베딩 생성 (fallback)
        const VECTOR_SIZE = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '384');
        return this.generateRandomEmbedding(VECTOR_SIZE);
      }
    } catch (error) {
      console.error('임베딩 생성 중 오류:', error);
      // 실패 시 랜덤 임베딩 생성 (fallback)
      const VECTOR_SIZE = parseInt(process.env.EMBEDDING_VECTOR_SIZE || '384');
      return this.generateRandomEmbedding(VECTOR_SIZE);
    }
  }
  
  /**
   * 임베딩 크기 정규화
   * @param embedding - 원본 임베딩 배열
   * @param targetSize - 목표 크기
   * @returns 정규화된 임베딩 배열
   */
  private normalizeEmbeddingSize(embedding: number[], targetSize: number): number[] {
    if (embedding.length === targetSize) {
      return embedding;
    }
    
    const result = new Array(targetSize).fill(0);
    
    if (embedding.length > targetSize) {
      // 큰 배열을 작게 만들기
      for (let i = 0; i < targetSize; i++) {
        const ratio = i / (targetSize - 1);
        const sourceIdx = Math.min(Math.floor(ratio * embedding.length), embedding.length - 1);
        result[i] = embedding[sourceIdx];
      }
    } else {
      // 작은 배열을 크게 만들기
      for (let i = 0; i < embedding.length; i++) {
        result[i] = embedding[i];
      }
      // 나머지는 0으로 채워짐
    }
    
    return result;
  }
  
  /**
   * 랜덤 임베딩 생성 (fallback용)
   * @param size - 임베딩 크기
   * @returns 랜덤 임베딩 배열
   */
  private generateRandomEmbedding(size: number): number[] {
    const embedding = [];
    for (let i = 0; i < size; i++) {
      embedding.push((Math.random() * 2 - 1) * 0.1); // -0.1 ~ 0.1 범위의 랜덤 값
    }
    return embedding;
  }
  
  /**
   * 대화 저장
   * @param threadId - 스레드 ID
   * @param messageId - 메시지 ID
   * @param userMessage - 사용자 메시지
   * @param botResponse - 봇 응답
   */
  async storeConversation(
    threadId: string,
    messageId: string,
    userMessage: string,
    botResponse: string
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (!this.collection) {
      throw new Error('Chroma 컬렉션이 초기화되지 않았습니다.');
    }
    
    try {
      // 사용자 메시지와 봇 응답 결합
      const combinedText = `사용자: ${userMessage}\n봇: ${botResponse}`;
      
      // 임베딩은 Chroma의 기본 임베딩 함수가 자동으로 처리
      
      // 고유 ID 생성 (threadId-messageId)
      const id = `${threadId}-${messageId}`;
      
      // Chroma DB에 저장
      await this.collection.add({
        ids: [id],
        // embeddings 필드를 생략하면 자동으로 임베딩 함수 사용
        metadatas: [{
          threadId,
          messageId,
          userMessage,
          botResponse,
          timestamp: new Date().toISOString()
        }],
        documents: [combinedText]
      });
      
      console.log(`스레드 ${threadId}의 대화가 벡터 DB에 저장되었습니다.`);
    } catch (error) {
      console.error('벡터 DB에 대화 저장 중 오류:', error);
    }
  }
  
  /**
   * 유사한 대화 검색
   * @param threadId - 스레드 ID
   * @param query - 검색 쿼리
   * @param limit - 반환할 결과 수
   * @returns 유사한 대화 목록
   */
  async searchSimilarConversations(
    threadId: string,
    query: string,
    limit: number = 5
  ): Promise<any[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (!this.collection) {
      throw new Error('Chroma 컬렉션이 초기화되지 않았습니다.');
    }
    
    try {
      // 벡터 검색 실행 (같은 스레드 내에서만)
      const results = await this.collection.query({
        queryTexts: [query],  // 텍스트로 직접 검색 (내부적으로 임베딩 함수 사용)
        nResults: limit,
        where: {
          threadId: threadId  // 동일한 스레드 내에서만 검색
        }
      });
      
      // 결과 포맷팅
      if (results.metadatas && results.metadatas[0]) {
        return results.metadatas[0].map((metadata: any, index: number) => {
          return {
            ...metadata,
            document: results.documents && results.documents[0] ? results.documents[0][index] || '' : '',
            distance: results.distances && results.distances[0] ? results.distances[0][index] || 0 : 0
          };
        });
      }
      
      return [];
    } catch (error) {
      console.error('유사한 대화 검색 중 오류:', error);
      return [];
    }
  }
  
  /**
   * 스레드의 모든 대화 가져오기
   * @param threadId - 스레드 ID
   * @returns 스레드의 모든 대화
   */
  async getAllThreadConversations(threadId: string): Promise<any[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (!this.collection) {
      throw new Error('Chroma 컬렉션이 초기화되지 않았습니다.');
    }
    
    try {
      // 스레드 ID로 필터링하여 모든 대화 가져오기
      const results = await this.collection.get({
        where: {
          threadId: threadId
        }
      });
      
      // 결과 포맷팅
      if (results.metadatas) {
        return results.metadatas.map((metadata: any, index: number) => {
          return {
            ...metadata,
            document: results.documents ? results.documents[index] || '' : '',
          };
        });
      }
      
      return [];
    } catch (error) {
      console.error(`스레드 ${threadId}의 대화 가져오기 중 오류:`, error);
      return [];
    }
  }
  
  /**
   * 스레드의 모든 대화 삭제
   * @param threadId - 스레드 ID
   */
  async deleteThreadConversations(threadId: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
    
    if (!this.collection) {
      throw new Error('Chroma 컬렉션이 초기화되지 않았습니다.');
    }
    
    try {
      // 스레드 ID로 필터링하여 모든 대화 삭제
      await this.collection.delete({
        where: {
          threadId: threadId
        }
      });
      
      console.log(`스레드 ${threadId}의 대화가 벡터 DB에서 삭제되었습니다.`);
    } catch (error) {
      console.error(`스레드 ${threadId}의 대화 삭제 중 오류:`, error);
    }
  }
}

// 싱글톤 인스턴스 생성 및 내보내기
export const vectorStore = new VectorStore();
