import dotenv from 'dotenv';
import { LMStudioClient } from '@lmstudio/sdk';
import { Client, Events, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { splitResponseIntoChunks } from './util/string.js';
import { WeatherDateTool } from './tools/weatherDateTool.js';
import { GooglePSETool } from './tools/googlePSETool.js';
import { conversationContext } from './util/conversationContext.js';
import { verifyResponse, addConfidenceDisclaimer } from './util/hallucination.js';
import { 
    detectTopicChange, 
    detectContextContamination, 
    shouldResetContext,
    addContaminationWarning 
} from './util/contextSeparation.js';

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

// 대화 맥락 기반 검색 함수
async function generateSearchResultsFromConversation(
  messageContent: string, 
  threadName: string, 
  compressedContext: string,
  model: any
): Promise<string> {
    try {
        // 대화 맥락과 현재 메시지를 결합하여 검색어 생성
        const searchQueryPrompt = `
다음은 이전 대화의 맥락 요약입니다:
${compressedContext || "이전 대화 맥락 없음"}

사용자의 현재 질문:
"${messageContent}"

위 정보를 바탕으로 사용자의 의도를 정확히 파악하여 검색엔진에 사용할 최적의 검색 쿼리를 1개 생성해주세요.
검색어는 2-3개 단어로 구성된 간결한 키워드여야 합니다.
가장 중요한 핵심 키워드는 큰따옴표로 감싸주세요.
검색어만 응답해주세요.
`;

        // 맥락 기반 검색어 생성
        const enhancedSearchQuery = await getModelResponse(searchQueryPrompt, model);
        console.log('맥락 기반 생성된 검색어:', enhancedSearchQuery);
        
        // 생성된 검색어로 컨텍스트 검색
        return await generateContext(enhancedSearchQuery, model);
    } catch (error) {
        console.error('맥락 기반 컨텍스트 생성 중 오류:', error);
        // 오류 시 기본 검색으로 fallback
        return await generateContext(`${messageContent} ${threadName}`, model);
    }
}

// 컨텍스트 생성 함수 수정
async function generateContext(query: string, model: any): Promise<string> {
    try {
        // PSE 검색 쿼리 생성 (맥락 기반 함수에서 이미 생성했으므로 주석 처리)
        // const queryContext = `다음 질문에 대해 검색엔진 최적화 키워드 2-4단어 이내로 하나의 문장 생성해줘. 키워드만 답변해주면 되고, 가장 중요한 핵심 키워드 큰따옴표로 감싸줘. 그 외에 다른 말은 하지마: ${query}`;
        // let searchQuery = await getModelResponse(queryContext, model);
        
        // 직접 검색어 사용
        let searchQuery = query;
        // // searchQuery = cleanSearchQuery(searchQuery); // 검색 쿼리 정리
        console.log('사용되는 검색 쿼리:', searchQuery);
        
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
    
    // 다른 사용자를 멘션한 경우 응답하지 않음 (봇 자신을 멘션한 경우는 제외)
    if (message.mentions.users.size > 0) {
        // 봇 자신 외에 다른 사용자가 멘션되어 있는지 확인
        const otherUsersMentioned = Array.from(message.mentions.users.values())
            .filter(user => user.id !== client.user?.id);
            
        if (otherUsersMentioned.length > 0) {
            console.log('다른 사용자를 멘션한 메시지이므로 응답하지 않습니다.');
            return;
        }
    }

    // Discord.js의 스레드 타입이 다양하므로 any 타입으로 처리 (원래는 더 정확한 타입을 사용하는 것이 좋음)
    let thread: any = null;
    let loadingMessage: Message | null = null;

    try {
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
        loadingMessage = await thread.send('생각 중...');

        // Redis에서 대화 이력 가져오기
        const threadId = thread.id;
        
        // 이전 대화 가져오기
        const previousConversation = await conversationContext.getConversationHistory(threadId);
        
        // 이전 대화가 있는 경우, 주제 변경 감지
        let resetContext = false;
        if (previousConversation.length >= 2) {
            const prevQuestionObj = previousConversation[previousConversation.length - 2];
            const prevResponseObj = previousConversation[previousConversation.length - 1];
            
            if (prevQuestionObj && prevResponseObj && 
                prevQuestionObj.role === 'user' && prevResponseObj.role === 'assistant') {
                
                const prevQuestion = prevQuestionObj.content;
                const prevResponse = prevResponseObj.content;
                
                // 주제 변경 감지
                const topicChangeResult = await detectTopicChange(
                    prevQuestion,
                    prevResponse,
                    message.content,
                    model
                );
                
                console.log(`주제 변경 감지 결과: ${topicChangeResult.isNewTopic ? '새 주제' : '같은 주제'}, 유사도: ${topicChangeResult.similarity}%`);
                console.log(`주제 분석: ${topicChangeResult.analysis}`);
                
                // 주제가 완전히 변경되었다면 컨텍스트 초기화 고려
                if (topicChangeResult.shouldResetContext) {
                    console.log('주제가 크게 변경되어 이전 대화 컨텍스트를 초기화합니다.');
                    resetContext = true;
                }
            }
        }
        
        // 현재 질문에 관련된 컨텍스트 가져오기
        const { compressedContext, similarConversations } = resetContext 
            ? { compressedContext: '', similarConversations: '' }
            : await conversationContext.getContextForQuery(threadId, message.content);
        
        const hasCompressedContext = compressedContext.length > 0 && !resetContext;
        const hasSimilarConversations = similarConversations.length > 0 && !resetContext;
        
        if (hasCompressedContext) {
            console.log(`스레드 ${threadId}의 압축된 맥락 로드 완료`);
        }
        
        if (hasSimilarConversations) {
            console.log(`스레드 ${threadId}의 유사 대화 검색 완료`);
        }
        
        if (resetContext) {
            console.log(`스레드 ${threadId}의 대화 맥락 초기화됨 (주제 변경)`);
        }

        // 컨텍스트 생성
        console.log(`사용자 질문: ${message.content}`);
        
        // 날씨/날짜 정보 요청인지 확인하고 처리
        const weatherDateObj = new WeatherDateTool();
        const weatherDateResult = await weatherDateObj.processWeatherAndDateRequests(message.content);
        
        // RAG 컨텍스트 생성 (날씨 질의일 경우 검색 건너뜀)
        let searchContext = '';
        if (!weatherDateResult.isProcessed) {
            // 날씨/날짜 관련 질의가 아닐 경우에만 PSE 검색 수행
            // 대화 맥락을 바탕으로 검색어 생성 후 검색
            searchContext = await generateSearchResultsFromConversation(
                message.content,
                thread.name,
                compressedContext,
                model
            );
        } else {
            console.log('날씨/날짜 질의로 판단되어 PSE 검색을 건너뜁니다.');
        }
        
        // 컨텍스트 정보 합치기 (환각 방지를 위한 개선된 구조)
        const contextData = {
            question: message.content,
            topic: thread.name,
            context: {
                conversationHistory: hasCompressedContext ? compressedContext : null,
                similarConversations: hasSimilarConversations ? similarConversations : null,
                weatherInfo: weatherDateResult.isProcessed ? weatherDateResult.contextInfo : null,
                searchResults: searchContext || null
            },
            timestamp: new Date().toISOString()
        };
        
        // 각 컨텍스트 소스별 존재 여부 추적
        const availableSources = [];
        if (hasCompressedContext) availableSources.push("대화 이력");
        if (hasSimilarConversations) availableSources.push("유사 대화");
        if (weatherDateResult.isProcessed) availableSources.push("날씨/날짜 정보");
        if (searchContext) availableSources.push("검색 결과");
        
        // 컨텍스트 요약 메시지 생성
        const sourcesSummary = availableSources.length > 0 
            ? `다음 정보를 참고할 수 있습니다: ${availableSources.join(', ')}` 
            : "참고할 수 있는 외부 정보가 없습니다.";
        
        // 환각 방지를 위한 프롬프트 구성
        const enhancedQuery = `
질문: ${message.content}
주제: ${thread.name}

${sourcesSummary}

${hasCompressedContext ? '--- 이전 대화 맥락 ---\n' + compressedContext + '\n\n' : ''}
${hasSimilarConversations ? '--- 관련 이전 대화 ---\n' + similarConversations + '\n\n' : ''}
${weatherDateResult.isProcessed ? '--- 날씨/날짜 정보 ---\n' + weatherDateResult.contextInfo + '\n\n' : ''}
${searchContext ? '--- 검색 결과 ---\n' + searchContext + '\n\n' : ''}

답변 작성 지침:
1. 제공된 정보에만 기반하여 답변하세요.
2. 사실을 지어내지 마세요.
3. 확실하지 않은 내용은 "제공된 정보만으로는 확실히 알 수 없습니다"라고 말하세요.
4. 필요한 정보가 없다면 솔직하게 모른다고 인정하세요.
`;

        console.log('사용자 질문:', message.content);
        console.log('날씨/날짜 정보:', weatherDateResult.isProcessed ? '포함됨' : '포함되지 않음');
        console.log('생성된 검색 컨텍스트:', searchContext ? '있음' : '없음');
        console.log('압축된 대화 맥락:', hasCompressedContext ? '포함됨' : '포함되지 않음');
        console.log('유사 대화 검색:', hasSimilarConversations ? '포함됨' : '포함되지 않음');
        
        // 강화된 시스템 메시지 구성
        const systemMessage = `당신은 정확하고 사실에 기반한 정보만 제공하는 디스코드 봇입니다. 
주어진 컨텍스트에 명확히 포함된 정보만 사용하세요.
확실하지 않은 정보는 추측하거나 지어내지 말고, 솔직하게 모른다고 인정하세요.
현재 날짜: ${new Date().toLocaleDateString('ko-KR')}
${hasCompressedContext || hasSimilarConversations ? '이전 대화 맥락을 참고하되, 맥락에 없는 내용을 지어내지 마세요.' : ''}
답변은 간결하고 직접적으로 작성하세요.`;

        // LLM에서 응답 가져오기
        const response = await getModelResponse(enhancedQuery, model, systemMessage);
        
        // 환각 감지 및 응답 검증 수행
        const { isReliable, verifiedResponse, confidenceScore } = await verifyResponse(
            contextData,
            response,
            model
        );
        
        // 주제 전환 및 문맥 오염 감지
        let finalResponse = isReliable ? response : verifiedResponse;
        let contaminationScore = 0;
        
        // 이전 대화가 있을 경우 문맥 오염 검사
        if (previousConversation.length >= 2 && !resetContext) {
            const prevQuestionObj = previousConversation[previousConversation.length - 2];
            const prevResponseObj = previousConversation[previousConversation.length - 1];
            
            if (prevQuestionObj && prevResponseObj && 
                prevQuestionObj.role === 'user' && prevResponseObj.role === 'assistant') {
                
                const prevQuestion = prevQuestionObj.content;
                const prevResponse = prevResponseObj.content;
                
                // 문맥 오염 감지
                const contaminationResult = await detectContextContamination(
                    prevQuestion,
                    prevResponse,
                    message.content,
                    finalResponse,
                    model
                );
                
                contaminationScore = contaminationResult.contaminationScore;
                console.log(`문맥 오염 감지 결과: ${contaminationResult.isContaminated ? '오염됨' : '정상'}, 오염도: ${contaminationScore}%`);
                
                // 오염이 감지되면 수정된 응답 사용
                if (contaminationResult.isContaminated && contaminationResult.cleanedResponse) {
                    console.log('문맥 오염이 감지되어 응답을 수정합니다.');
                    finalResponse = contaminationResult.cleanedResponse;
                }
            }
        }
        
        // 신뢰도와 오염도에 따른 경고 추가
        // finalResponse = addConfidenceDisclaimer(finalResponse, confidenceScore);
        // finalResponse = addContaminationWarning(finalResponse, contaminationScore);
        
        console.log(`응답 신뢰도: ${confidenceScore}%, 검증 통과: ${isReliable ? '예' : '아니오'}, 문맥 오염도: ${contaminationScore}%`);

        // 로딩 메시지 삭제 후 실제 응답 전송
        if (loadingMessage) {
            await loadingMessage.delete();
        }

        // response가 2000자 넘을 경우 나눠서 발송
        if (finalResponse.length > 2000) {
            const chunks = splitResponseIntoChunks(finalResponse);
            for (const chunk of chunks) {
                await thread.send(chunk);
            }
        } else {
            await thread.send(finalResponse);
        }
        
        // Redis에 대화 저장 및 컨텍스트 압축
        const conversation = [
            { role: 'user', content: message.content },
            { role: 'assistant', content: finalResponse }
        ];
        
        try {
            // 대화 저장 및 컨텍스트 압축 생성
            await conversationContext.generateAndSaveSummary(
                threadId,
                model, // LLM 모델 객체
                message.content, // 최신 사용자 메시지
                response // 최신 봇 응답
            );
            
            // 벡터 DB에 저장 (메시지 ID 함께 저장)
            await conversationContext.saveConversation(
                threadId,
                message.content,
                finalResponse,
                message.id // Discord 메시지 ID
            );
            
            // 주제 변경으로 컨텍스트 초기화가 필요한 경우
            if (resetContext) {
                // 기존 대화는 유지하되 요약(summary)만 초기화
                await conversationContext.saveSummary(threadId, "");
                console.log(`스레드 ${threadId}의 대화 요약 초기화 완료 (주제 변경)`);
                
                // 주제 변경을 사용자에게 알림
                // await thread.send("💡 **새로운 주제가 감지되어 대화 맥락을 초기화했습니다.**");
            }
            
            console.log(`스레드 ${threadId}의 대화 이력 저장 및 컨텍스트 압축 완료`);
        } catch (redisError) {
            console.error('대화 컨텍스트 저장 중 오류:', redisError);
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

        // 스레드 삭제 이벤트 감지
        client.on(Events.ThreadDelete, async (thread) => {
            try {
                const threadId = thread.id;
                console.log(`스레드 삭제 감지: ${thread.name} (ID: ${threadId})`);
                
                // 대화 컨텍스트 및 벡터 DB에서 관련 데이터 삭제
                await conversationContext.clearConversation(threadId);
                console.log(`스레드 ${threadId}의 대화 데이터 삭제 완료`);
            } catch (error) {
                console.error('스레드 삭제 이벤트 처리 중 오류:', error);
            }
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