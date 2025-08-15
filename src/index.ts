import dotenv from 'dotenv';
import { LMStudioClient } from '@lmstudio/sdk';
import { Client, Events, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { splitResponseIntoChunks } from './util/string.js';
import { WeatherDateTool } from './tools/weatherDateTool.js';
import { GooglePSETool } from './tools/googlePSETool.js';
import { conversationContext } from './util/conversationContext.js';

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

async function getModelResponse(userMessage: string, model: any, systemMessage?: string): Promise<string> {
    try {
        const messages = [
            { 
                role: 'system', 
                content: systemMessage || '당신은 도움이 되는 디스코드 봇입니다. 현재 날짜와 시간, 날씨 정보에 접근할 수 있습니다.'
            },
            { role: 'user', content: userMessage },
        ];
        
        const prediction = await model.respond(
            messages,
            {
                max_tokens: 2000, // 생성할 최대 토큰 수 제한
                // temperature: 0.7, // 응답의 창의성 조절 (선택사항)
                // top_p: 0.9 // 토큰 샘플링 파라미터 (선택사항)
            }
        );

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
        
        // GooglePSETool 인스턴스 생성
        const googlePSE = new GooglePSETool();
        
        // PSE 검색 실행
        const searchResults = await googlePSE.search(searchQuery);
        
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

// 검색 결과 요약 함수
async function summarizeSearchResults(query: string, results: any[], model: any): Promise<string> {
    // GooglePSETool 인스턴스 생성
    const googlePSE = new GooglePSETool();
    
    // 포맷된 검색 결과로 요약 프롬프트 생성
    const summaryPrompt = googlePSE.generateSummaryPrompt(query, results);
    
    if (!summaryPrompt) {
        return '';
    }
    
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

    // Discord.js의 스레드 타입이 다양하므로 any 타입으로 처리 (원래는 더 정확한 타입을 사용하는 것이 좋음)
    let thread: any = null;
    let loadingMessage: Message | null = null;

    try {
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
        loadingMessage = await thread.send('생각 중...');

        // Redis에서 대화 이력 가져오기
        const threadId = thread.id;
        
        // 압축된 맥락 가져오기 (이전 대화의 요약)
        const compressedContext = await conversationContext.getSummary(threadId);
        const hasCompressedContext = compressedContext.length > 0;
        
        if (hasCompressedContext) {
            console.log(`스레드 ${threadId}의 압축된 맥락 로드 완료`);
        }

        // 컨텍스트 생성
        console.log(`질의에 관한 컨텍스트: ${messageContext}`)
        
        // 날씨/날짜 정보 요청인지 확인하고 처리
        const weatherDateObj = new WeatherDateTool();
        const weatherDateResult = await weatherDateObj.processWeatherAndDateRequests(message.content);
        
        // RAG 컨텍스트 생성 (날씨 질의일 경우 검색 건너뜀)
        let searchContext = '';
        if (!weatherDateResult.isProcessed) {
            // 날씨/날짜 관련 질의가 아닐 경우에만 PSE 검색 수행
            searchContext = await generateContext(messageContext, model);
        } else {
            console.log('날씨/날짜 질의로 판단되어 PSE 검색을 건너뜁니다.');
        }
        
        // 컨텍스트 정보 합치기 (압축된 맥락 + 날씨/날짜 + 검색 결과)
        let combinedContext = '';
        
        // 압축된 맥락이 있는 경우 포함
        if (hasCompressedContext) {
            combinedContext += `이전 대화 맥락 요약:\n${compressedContext}\n\n`;
        }
        
        // 날씨/날짜 정보 포함
        if (weatherDateResult.isProcessed && weatherDateResult.contextInfo) {
            combinedContext += weatherDateResult.contextInfo;
        }
        
        // 검색 결과 포함
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
        console.log('압축된 대화 맥락:', hasCompressedContext ? '포함됨' : '포함되지 않음');
        
        // 시스템 메시지 구성
        const systemMessage = `당신은 도움이 되는 디스코드 봇입니다. 현재 날짜와 시간, 날씨 정보에 접근할 수 있습니다. ${
            hasCompressedContext ? '이전 대화 맥락을 기억하고 일관된 응답을 제공하세요.' : ''
        }`;

        // LLM에서 응답 가져오기
        const response = await getModelResponse(enhancedQuery, model, systemMessage);

        // 로딩 메시지 삭제 후 실제 응답 전송
        if (loadingMessage) {
            await loadingMessage.delete();
        }

        // response가 2000자 넘을 경우 나눠서 발송
        if (response.length > 2000) {
            const chunks = splitResponseIntoChunks(response);
            for (const chunk of chunks) {
                await thread.send(chunk);
            }
        } else {
            await thread.send(response);
        }
        
        // Redis에 대화 저장 및 컨텍스트 압축
        const conversation = [
            { role: 'user', content: message.content },
            { role: 'assistant', content: response }
        ];
        
        try {
            // 대화 저장 및 컨텍스트 압축 생성
            await conversationContext.generateAndSaveSummary(
                threadId,
                model, // LLM 모델 객체
                message.content, // 최신 사용자 메시지
                response // 최신 봇 응답
            );
            console.log(`스레드 ${threadId}의 대화 이력 저장 및 컨텍스트 압축 완료`);
        } catch (redisError) {
            console.error('Redis에 대화 컨텍스트 저장 중 오류:', redisError);
        }
        
    } catch (error) {
        console.error('메시지 처리 중 오류 발생:', error);
        
        // 오류 발생 시 로딩 메시지 삭제 및 오류 피드백 전송
        try {
            if (loadingMessage) {
                await loadingMessage.delete();
            }
            
            // 사용자에게 오류 알림 전송
            if (thread) {
                const errorMessage = `죄송합니다. 요청을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.`;
                await thread.send(errorMessage);
            }
        } catch (feedbackError) {
            console.error('오류 피드백 전송 중 추가 오류 발생:', feedbackError);
        }
    }
}

// 봇 실행 함수
async function main() {
    try {
        // Redis 연결 초기화
        await conversationContext.initialize();
        console.log('Redis 대화 컨텍스트 관리자 초기화 완료');
        
        // 프로세스 종료 시 Redis 연결 닫기
        process.on('SIGINT', async () => {
            console.log('애플리케이션 종료 중...');
            await conversationContext.disconnect();
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            console.log('애플리케이션 종료 중...');
            await conversationContext.disconnect();
            process.exit(0);
        });

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
        // Redis 연결 종료 시도
        try {
            await conversationContext.disconnect();
        } catch (redisError) {
            console.error('Redis 연결 종료 중 오류:', redisError);
        }
    }
}

main();