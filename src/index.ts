import dotenv from 'dotenv';
import { LMStudioClient } from '@lmstudio/sdk';
import { Client, Events, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { splitResponseIntoChunks } from './util/string.js';
import { getCurrentDateTime, getWeather, formatWeatherInfo } from './util/weather.js';

dotenv.config();

const CLIENT_TOKEN = process.env.CLIENT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

// 디스코드 클라이언트 설정
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

async function getLLMModel(): Promise<any> {
    const client = new LMStudioClient();

    // 로드된 모델 목록 확인
    const loadedModels = await client.llm.listLoaded();

    if (loadedModels.length === 0) {
        throw new Error('로드된 모델이 없습니다. LM Studio에서 모델을 먼저 로드해주세요.');
    }

    // console.log(loadedModels);

    return loadedModels[0]; // 첫 번째 모델 사용
}

async function getModelResponse(userMessage: string, model: any): Promise<string> {
    try {
        const prediction = await model.respond([
            { role: 'system', content: '당신은 도움이 되는 디스코드 봇입니다. 현재 날짜와 시간, 날씨 정보에 접근할 수 있습니다.' },
            { role: 'user', content: userMessage },
        ],
        {
            max_tokens: 2000, // 생성할 최대 토큰 수 제한
            // temperature: 0.7, // 응답의 창의성 조절 (선택사항)
            // top_p: 0.9 // 토큰 샘플링 파라미터 (선택사항)
        });

        return prediction.content;
    } catch (error) {
        console.error('모델 응답 생성 중 오류:', error);
        // return '죄송합니다. 응답을 생성하는 중에 오류가 발생했습니다.';
        return ''; // 오류 발생 시 빈 문자열 반환(참고자료 없음)
    }
}

// 컨텍스트 생성 함수 수정
async function generateContext(query: string, model: any): Promise<string> {
    try {
        // PSE 검색 쿼리 생성
        const queryContext = `다음 질문에 대해 검색엔진 최적화 키워드 2-4단어 이내로 하나의 문장 생성해줘. 키워드만 답변해주면 되고, 가장 중요한 핵심 키워드 큰따옴표로 감싸줘. 그 외에 다른 말은 하지마: ${query}`;
        let searchQuery = await getModelResponse(queryContext, model);
        // // searchQuery = cleanSearchQuery(searchQuery); // 검색 쿼리 정리
        console.log('생성된 PSE 검색 쿼리:', searchQuery);
        // PSE 검색 실행
        const searchResults = await performPSESearch(searchQuery);
        
        // 검색 결과가 있으면 요약 생성
        if (searchResults && searchResults.length > 0) {
            const contextSummary = await summarizeSearchResults(query, searchResults, model);
            return contextSummary;
        }
        
        return ''; // 검색 결과 없으면 빈 컨텍스트
    } catch (error) {
        console.error('컨텍스트 생성 중 오류:', error);
        return ''; // 오류 시 빈 컨텍스트로 fallback
    }
}

// PSE 검색 함수
async function performPSESearch(query: string): Promise<any[]> {
    const PSE_API_KEY = process.env.GOOGLE_PSE_API_KEY;
    const PSE_ENGINE_ID = process.env.GOOGLE_PSE_ENGINE_ID;

    const searchCount = process.env.GOOGLE_PSE_COUNT ? process.env.GOOGLE_PSE_COUNT : '5'; // 기본값 5

    const searchUrl = `https://www.googleapis.com/customsearch/v1`;
    const params = new URLSearchParams({
        key: PSE_API_KEY!,
        cx: PSE_ENGINE_ID!,
        q: query,
        num: searchCount // 검색 결과 5건
    });
    
    const response = await fetch(`${searchUrl}?${params}`);
    const data = await response.json();
    
    return data.items || [];
}

// 검색 결과 요약 함수
async function summarizeSearchResults(query: string, results: any[], model: any): Promise<string> {
    const searchContent = results.map((item, index) => 
        `[${index + 1}] ${item.title}\n${item.snippet}\n`
    ).join('\n');
    
    // 간단한 요약 프롬프트
    const summaryPrompt = `
다음 검색 결과를 바탕으로 핵심 내용만 간단히 요약해주세요. 질의와 상관없는 검색 결과는 제외합니다.
${query}

검색 결과:
${searchContent}


요약:`;

    console.log('-- 요약 프롬프트 생성 완료 --');
    console.log('요약 요청 프롬프트:', summaryPrompt);
    console.log('-- 요약 프롬프트 생성 완료 --');
    
    // LM Studio로 요약 요청 (모델 객체 사용)
    const summary = await getModelResponse(summaryPrompt, model);
    return summary;
}

// 메시지 처리 함수
async function handleMessage(message: Message, model: any) {
    // console.log(message.guild.id, message.channel.id, message.thread?.id);
    // 봇 메시지 무시 및 DM 무시
    if (message.author.bot || !message.guild) return;

    try {
        let thread;
        let messageContext = ''; // 질의에 대해 컨텍스트 유지하기 위한 

        // 이미 스레드가 있는 경우 해당 스레드 사용
        if (message.channel.isThread()) {
            // 이미 스레드 내에 있으면 해당 스레드 사용
            thread = message.channel;
            console.log('기존 스레드에 응답합니다:', thread.name);

            messageContext = `질의 스레드 주제:${thread.name}\n\n사용자 질의: ${message.content}`;

        } else {
            // 스레드가 없는 경우 새로 생성
            const channel = message.channel as TextChannel;
            thread = await channel.threads.create({
                name: `"${message.content}"에 대한 답변`,
                autoArchiveDuration: 60, // 60분 후 자동 보관
                reason: '사용자 질문에 대한 답변 스레드 생성'
            });

            messageContext = `사용자 질의: ${message.content}`;
        }

        // 스레드에 "생각 중..." 메시지 전송
        const loadingMessage = await thread.send('생각 중...');

        // 컨텍스트 생성
        // const searchContext = await generateContext(message.content, model);
        console.log(`질의에 관한 컨텍스트: ${messageContext}`)
        
        // 날씨/날짜 정보 요청인지 확인하고 처리
        const weatherDateResult = await processWeatherAndDateRequests(message.content);
        
        // RAG 컨텍스트 생성
        const searchContext = await generateContext(messageContext, model);
        
        // 컨텍스트 정보 합치기 (날씨/날짜 + 검색 결과)
        let combinedContext = '';
        if (weatherDateResult.isProcessed && weatherDateResult.contextInfo) {
            combinedContext += weatherDateResult.contextInfo;
        }
        if (searchContext) {
            combinedContext += searchContext;
        }
        
        // 컨텍스트가 있으면 프롬프트에 포함
        const enhancedQuery = combinedContext 
            ? `참고 정보:\n${combinedContext}\n\n사용자 질문: ${message.content}\n\n질의 주제: ${thread.name}`
            : message.content;

        console.log('사용자 질문:', message.content);
        console.log('날씨/날짜 정보:', weatherDateResult.isProcessed ? '포함됨' : '포함되지 않음');
        console.log('생성된 검색 컨텍스트:', searchContext);
        console.log('강화된 쿼리:', enhancedQuery);

        // LLM에서 응답 가져오기
        const response = await getModelResponse(enhancedQuery, model);

        // 로딩 메시지 삭제 후 실제 응답 전송
        await loadingMessage.delete();

        // response가 2000자 넘을 경우 나눠서 발송
        if (response.length > 2000) {
            const chunks = splitResponseIntoChunks(response);
            for (const chunk of chunks) {
                await thread.send(chunk);
            }
        } else {
            await thread.send(response);
        }
    } catch (error) {
        console.error('메시지 처리 중 오류 발생:', error);
    }
}

// 날씨 및 날짜 정보 요청 감지 및 처리
async function processWeatherAndDateRequests(message: string): Promise<{
  isProcessed: boolean;
  contextInfo?: string;
}> {
  // 메시지 소문자로 변환하여 비교
  const lowerMsg = message.toLowerCase();
  
  // 날짜/시간 관련 키워드
  const dateTimeKeywords = ['날짜', '시간', '요일', '몇 시', '며칠', '오늘'];
  // 날씨 관련 키워드
  const weatherKeywords = ['날씨', '기온', '온도', '습도', '바람', '기상'];
  
  // 위치 패턴 감지 (다양한 형태의 위치 질문 처리)
  // 예: "서울 날씨", "부산 날씨 알려줘", "오늘 서울 날씨 어때?"
  const locationPattern = /([가-힣]+[시군구]?)(?:\s+|의\s*|\s*지역\s*)(날씨|기온|온도|습도|바람|기상)/;
  // 백업 패턴 (위 패턴이 매치되지 않을 경우)
  const backupLocationPattern = /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:\s+|에|의|지역)?/;
  const locationMatch = message.match(locationPattern);
  
  let contextInfo = '';
  let isProcessed = false;
  
  // 날짜/시간 정보 요청 감지
  if (dateTimeKeywords.some(keyword => lowerMsg.includes(keyword))) {
    const dateTimeInfo = getCurrentDateTime();
    contextInfo += `현재 날짜와 시간: ${dateTimeInfo.fullDateTime}\n\n`;
    isProcessed = true;
  }
  
  // 날씨 정보 요청 감지
  if (weatherKeywords.some(keyword => lowerMsg.includes(keyword))) {
    try {
      // 위치 추출 시도
      let location = '서울'; // 기본값
      
      // 첫 번째 패턴으로 위치 추출 시도
      const locationMatch = message.match(locationPattern);
      if (locationMatch && locationMatch[1]) {
        location = locationMatch[1];
      } else {
        // 백업 패턴으로 위치 추출 시도
        const backupMatch = message.match(backupLocationPattern);
        if (backupMatch && backupMatch[1]) {
          location = backupMatch[1];
        }
      }
      
      console.log(`날씨 정보 요청 감지 - 위치: ${location}`);
      
      try {
        const weatherData = await getWeather(location);
        
        if (weatherData) {
          contextInfo += formatWeatherInfo(weatherData) + '\n\n';
          console.log('날씨 정보 포맷팅 완료');
        }
      } catch (weatherError) {
        console.error('날씨 API 호출 중 오류:', weatherError);
        contextInfo += `날씨 정보를 제공할 수 없습니다. OpenWeatherMap API 키가 아직 활성화되지 않았거나 유효하지 않습니다.\n\n현재 서비스 상태를 확인 중입니다. 나중에 다시 시도해주세요.\n\n`;
        
        // 개발자용 로그
        console.log('날씨 API 키 확인 필요:', process.env.OPENWEATHER_API_KEY);
      }
      
      isProcessed = true;
    } catch (error) {
      console.error('날씨 정보 처리 중 오류:', error);
      contextInfo += `날씨 정보를 가져오는 데 문제가 발생했습니다.\n\n`;
      isProcessed = true;
    }
  }
  
  return { isProcessed, contextInfo };
}

// 봇 실행 함수
async function main() {
    try {
        // LLM 모델 로드
        const model = await getLLMModel();
        console.log('모델 로드 완료:', model.displayName);

        // 클라이언트 준비 이벤트
        client.once(Events.ClientReady, (readyClient) => {
            console.log(`${readyClient.user.tag} 봇이 준비되었습니다!`);
        });

        // 메시지 생성 이벤트
        client.on(Events.MessageCreate, async (message) => {
            await handleMessage(message, model);
        });

        // client.on(Events.ThreadCreate, async (thread) => {
        //     if (thread.messages.channel.id === '1297140548062281791') {
        //         console.log('스레드 생성:', thread.name);
        //         const message = thread.lastMessage; // 메서드 아닌 속성으로 수정
        //         console.log('마지막 메시지:', message);
        //     }
        // });
        //
        // client.on(Events.ThreadUpdate, async (thread) => {
        //     console.log('스레드 업데이트:', thread.name);
        // })

        // 디스코드 로그인
        await client.login(CLIENT_TOKEN);
    } catch (error) {
        console.error('봇 실행 중 오류 발생:', error);
    }
}

main();