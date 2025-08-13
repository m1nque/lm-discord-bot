import dotenv from 'dotenv';
import { LMStudioClient } from '@lmstudio/sdk';
import { Client, Events, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { splitResponseIntoChunks } from './util/string.js';

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
            { role: 'system', content: '당신은 도움이 되는 디스코드 봇입니다.' },
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
        // const queryContext = `다음 질문에 대해 효과적인 Search Engine 쿼리 1건 생성, 단답형: ${query}`;
        // let searchQuery = await getModelResponse(queryContext, model);
        // // searchQuery = cleanSearchQuery(searchQuery); // 검색 쿼리 정리
        // console.log('생성된 PSE 검색 쿼리:', searchQuery);
        // PSE 검색 실행
        const searchResults = await performPSESearch(query);
        
        // 검색 결과가 있으면 요약 생성
        if (searchResults && searchResults.length > 0) {
            const contextSummary = await summarizeSearchResults(searchResults, model);
            return contextSummary;
        }
        
        return ''; // 검색 결과 없으면 빈 컨텍스트
    } catch (error) {
        console.error('컨텍스트 생성 중 오류:', error);
        return ''; // 오류 시 빈 컨텍스트로 fallback
    }
}


// 검색 쿼리 정리 함수 추가
// function cleanSearchQuery(query: string): string {
//     // 입력이 없거나 undefined인 경우 처리
//     if (!query) return '';
    
//     // 줄바꿈, 특수 기호 제거
//     let cleaned = query.trim();
    
//     // 추천:, 검색어:, 쿼리: 등으로 시작하는 경우 해당 부분 제거
//     cleaned = cleaned.replace(/^(추천:|검색어:|쿼리:|검색 쿼리:|효과적인 검색 쿼리:|PSE 검색 쿼리:)\s*/i, '');
    
//     // 설명이 포함된 경우 첫 줄만 사용
//     if (cleaned && cleaned.includes('\n')) {
//         const lines = cleaned.split('\n');
//         // 명시적으로 첫 번째 요소가 존재하는지 확인
//         const firstLine = lines.length > 0 ? lines[0] : '';
//         try {
//             cleaned = firstLine.trim();    
//         } catch (error) {
//             console.error('첫 줄 처리 중 오류 발생:', error);
//             return query; // 오류 발생 시 원본 쿼리 반환
//         }
//     }
    
//     // 불필요한 마크다운 포맷 제거
//     if (cleaned) {
//         cleaned = cleaned.replace(/^\*\*|\*\*$/g, '').replace(/^#+ /g, '');
//     }
    
//     // 앞뒤 따옴표만 있는 경우 제거 (검색 쿼리 자체에 따옴표가 필요한 경우 제외)
//     if (cleaned && cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.split('"').length === 3) {
//         cleaned = cleaned.substring(1, cleaned.length - 1);
//     }
    
//     return cleaned || '';
// }

// PSE 검색 함수
async function performPSESearch(query: string): Promise<any[]> {
    const PSE_API_KEY = process.env.GOOGLE_PSE_API_KEY;
    const PSE_ENGINE_ID = process.env.GOOGLE_PSE_ENGINE_ID;
    
    const searchUrl = `https://www.googleapis.com/customsearch/v1`;
    const params = new URLSearchParams({
        key: PSE_API_KEY!,
        cx: PSE_ENGINE_ID!,
        q: query,
        num: '5' // 검색 결과 5건
    });
    
    const response = await fetch(`${searchUrl}?${params}`);
    const data = await response.json();
    
    return data.items || [];
}

// 검색 결과 요약 함수
async function summarizeSearchResults(results: any[], model: any): Promise<string> {
    const searchContent = results.map((item, index) => 
        `[${index + 1}] ${item.title}\n${item.snippet}\n`
    ).join('\n');
    
    // 간단한 요약 프롬프트
    const summaryPrompt = `
다음 검색 결과를 바탕으로 핵심 내용만 간단히 요약해주세요:

${searchContent}

요약:`;

    console.log('요약 요청 프롬프트:', summaryPrompt);
    
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

        // 이미 스레드가 있는 경우 해당 스레드 사용
        if (message.channel.isThread()) {
            // 이미 스레드 내에 있으면 해당 스레드 사용
            thread = message.channel;
            console.log('기존 스레드에 응답합니다:', thread.name);
        } else {
            // 스레드가 없는 경우 새로 생성
            const channel = message.channel as TextChannel;
            thread = await channel.threads.create({
                name: `"${message.content}"에 대한 답변`,
                autoArchiveDuration: 60, // 60분 후 자동 보관
                reason: '사용자 질문에 대한 답변 스레드 생성'
            });
        }

        // 스레드에 "생각 중..." 메시지 전송
        const loadingMessage = await thread.send('생각 중...');

        // 컨텍스트 생성
        const searchContext = await generateContext(message.content, model);
        // 컨텍스트가 있으면 프롬프트에 포함
        const enhancedQuery = searchContext 
            ? `참고 정보:\n${searchContext}\n\n사용자 질문: ${message.content}`
            : message.content;

        console.log('사용자 질문:', message.content);
        console.log('생성된 컨텍스트:', searchContext);
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