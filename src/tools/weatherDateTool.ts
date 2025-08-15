import dotenv from 'dotenv';
import moment from 'moment';
import axios from 'axios';
// @ts-ignore
import 'moment/locale/ko'; // 한국어 로케일 설정

// 환경 변수가 확실히 로드되도록 dotenv 설정
dotenv.config();

/**
 * 날씨 및 날짜 정보 관련 도구
 * 나중에 LangChain으로 확장 가능하도록 설계
 */
export class WeatherDateTool {
  private apiKey: string;
  private useOneCallApi: boolean;

  /**
   * WeatherDateTool 생성자
   * @param apiKey - OpenWeatherMap API 키 (없으면 환경변수에서 로드)
   * @param useOneCallApi - One Call API 3.0 사용 여부 (유료 플랜 필요할 수 있음)
   */
  constructor(apiKey?: string, useOneCallApi?: boolean) {
    this.apiKey = apiKey || process.env.OPENWEATHER_API_KEY || '';
    this.useOneCallApi = useOneCallApi || process.env.USE_ONECALL_API === 'true' || false;

    if (!this.apiKey) {
      console.warn('OpenWeatherMap API 키가 설정되지 않았습니다. 날씨 기능이 제한됩니다.');
    }
    
    console.log(`날씨 도구 초기화 - One Call API 사용: ${this.useOneCallApi ? '예' : '아니오'}`);
  }

  /**
   * 현재 날짜 및 시간 정보를 가져오는 함수
   * @returns 날짜, 시간, 요일, 전체 날짜시간 문자열을 포함한 객체
   */
  getCurrentDateTime(): { 
    date: string; 
    time: string; 
    dayOfWeek: string;
    fullDateTime: string;
  } {
    moment.locale('ko'); // 한국어 설정
    
    const now = moment();
    return {
      date: now.format('YYYY년 MM월 DD일'),
      time: now.format('HH시 mm분'),
      dayOfWeek: now.format('dddd'),
      fullDateTime: now.format('YYYY년 MM월 DD일 HH시 mm분 (dddd)')
    };
  }

  /**
   * 지정된 위치의 날씨 정보를 가져오는 함수
   * @param location - 날씨 정보를 가져올 위치 (기본값: '서울')
   * @returns 날씨 정보 객체
   */
  async getWeather(location: string = '서울'): Promise<any> {
    try {
      if (!this.apiKey) {
        console.error('OpenWeatherMap API 키가 설정되지 않았습니다.');
        throw new Error('OpenWeatherMap API 키가 설정되지 않았습니다. .env 파일에 OPENWEATHER_API_KEY를 추가해주세요.');
      }
      
      console.log(`날씨 정보 요청 - 위치: ${location}, API 키 존재: ${this.apiKey ? '예' : '아니오'}`);
      
      // 위치 정보 검색 (좌표 획득)
      try {
        const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${this.apiKey}`;
        console.log(`지오코딩 API 요청: ${geoUrl.replace(this.apiKey, 'API_KEY_HIDDEN')}`);
        
        const geoResponse = await axios.get(geoUrl);
        
        if (!geoResponse.data || geoResponse.data.length === 0) {
          console.error(`위치 정보를 찾을 수 없습니다: ${location}`);
          throw new Error(`위치 정보를 찾을 수 없습니다: ${location}`);
        }
        
        const { lat, lon } = geoResponse.data[0];
        console.log(`위치 정보 획득 성공 - 위도: ${lat}, 경도: ${lon}`);
        
        let weatherData;
        
        // API 버전에 따라 다른 엔드포인트 사용
        if (this.useOneCallApi) {
          // One Call API 3.0 사용 (유료 플랜 필요할 수 있음)
          const weatherUrl = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,alerts&appid=${this.apiKey}&units=metric&lang=kr`;
          console.log(`날씨 API 요청 (One Call 3.0): ${weatherUrl.replace(this.apiKey, 'API_KEY_HIDDEN')}`);
          
          const weatherResponse = await axios.get(weatherUrl);
          const data = weatherResponse.data;
          
          weatherData = {
            location: location, // One Call API는 위치 이름을 반환하지 않으므로 요청 위치 사용
            description: data.current.weather[0].description,
            temperature: data.current.temp,
            feelsLike: data.current.feels_like,
            humidity: data.current.humidity,
            windSpeed: data.current.wind_speed,
            sunrise: moment.unix(data.current.sunrise).format('HH:mm'),
            sunset: moment.unix(data.current.sunset).format('HH:mm'),
            // 추가 정보 - One Call API의 일일 예보에서 가져옴
            dailyForecast: data.daily ? data.daily.slice(0, 1).map((day: any) => ({
              date: moment.unix(day.dt).format('MM월 DD일'),
              tempMin: day.temp.min,
              tempMax: day.temp.max,
              description: day.weather[0].description
            })) : []
          };
        } else {
          // 기본 Weather API 2.5 사용 (무료)
          const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${this.apiKey}&units=metric&lang=kr`;
          console.log(`날씨 API 요청 (Weather 2.5): ${weatherUrl.replace(this.apiKey, 'API_KEY_HIDDEN')}`);
          
          const weatherResponse = await axios.get(weatherUrl);
          const data = weatherResponse.data;
          
          weatherData = {
            location: data.name,
            description: data.weather[0].description,
            temperature: data.main.temp,
            feelsLike: data.main.feels_like,
            humidity: data.main.humidity,
            windSpeed: data.wind.speed,
            sunrise: moment.unix(data.sys.sunrise).format('HH:mm'),
            sunset: moment.unix(data.sys.sunset).format('HH:mm'),
            dailyForecast: [] // 기본 API에는 일일 예보 정보가 없음
          };
        }
        
        console.log('날씨 데이터 획득 성공');
        return weatherData;
      } catch (requestError) {
        console.error('API 요청 중 오류:', requestError);
        if (axios.isAxiosError(requestError) && requestError.response) {
          console.error('API 응답 상태 코드:', requestError.response.status);
          console.error('API 응답 데이터:', requestError.response.data);
        }
        throw requestError;
      }
    } catch (error) {
      console.error('날씨 정보 가져오기 실패:', error);
      if (axios.isAxiosError(error) && error.response) {
        console.error('API 응답:', error.response.data);
      }
      throw new Error(`날씨 정보를 가져오는 중 오류가 발생했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`);
    }
  }

  /**
   * 날씨 정보를 텍스트로 포맷팅
   * @param weatherData - 날씨 정보 객체
   * @returns 포맷팅된 날씨 정보 문자열
   */
  formatWeatherInfo(weatherData: any): string {
    let formattedInfo = `
📍 **${weatherData.location}** 날씨 정보:
- 날짜: ${this.getCurrentDateTime().date}
- 날씨: ${weatherData.description}
- 현재 기온: ${weatherData.temperature}°C (체감 온도: ${weatherData.feelsLike}°C)
- 습도: ${weatherData.humidity}%
- 풍속: ${weatherData.windSpeed}m/s
- 일출: ${weatherData.sunrise}
- 일몰: ${weatherData.sunset}`;

    // 일일 예보 정보가 있으면 추가
    if (weatherData.dailyForecast && weatherData.dailyForecast.length > 0) {
      const forecast = weatherData.dailyForecast[0];
      formattedInfo += `

🔮 **내일 예보**:
- 날짜: ${forecast.date}
- 날씨: ${forecast.description}
- 최저/최고 기온: ${forecast.tempMin}°C / ${forecast.tempMax}°C`;
    }
    
    return formattedInfo.trim();
  }

  /**
   * 텍스트에서 위치 정보 추출
   * @param message - 위치를 추출할 텍스트
   * @returns 추출된 위치 (기본값: '서울')
   */
  extractLocationFromMessage(message: string): string {
    // 위치 패턴 감지 (다양한 형태의 위치 질문 처리)
    // 예: "서울 날씨", "부산 날씨 알려줘", "오늘 서울 날씨 어때?"
    const locationPattern = /([가-힣]+[시군구]?)(?:\s+|의\s*|\s*지역\s*)(날씨|기온|온도|습도|바람|기상)/;
    // 백업 패턴 (위 패턴이 매치되지 않을 경우)
    const backupLocationPattern = /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:\s+|에|의|지역)?/;
    
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
    
    return location;
  }

  /**
   * 메시지에 날씨 또는 날짜 관련 질문이 포함되어 있는지 확인
   * @param message - 확인할 메시지
   * @returns 날씨/날짜 관련 여부 및 컨텍스트 정보 객체
   */
  async processWeatherAndDateRequests(message: string): Promise<{
    isProcessed: boolean;
    contextInfo?: string;
  }> {
    // 메시지 소문자로 변환하여 비교
    const lowerMsg = message.toLowerCase();
    
    // 날짜/시간 관련 키워드
    const dateTimeKeywords = ['날짜', '시간', '요일', '몇 시', '며칠', '오늘'];
    // 날씨 관련 키워드
    const weatherKeywords = ['날씨', '기온', '온도', '습도', '바람', '기상'];
    
    let contextInfo = '';
    let isProcessed = false;
    
    // 날짜/시간 정보 요청 감지
    if (dateTimeKeywords.some(keyword => lowerMsg.includes(keyword))) {
      const dateTimeInfo = this.getCurrentDateTime();
      contextInfo += `현재 날짜와 시간: ${dateTimeInfo.fullDateTime}\n\n`;
      isProcessed = true;
    }
    
    // 날씨 정보 요청 감지
    if (weatherKeywords.some(keyword => lowerMsg.includes(keyword))) {
      try {
        // 위치 추출
        const location = this.extractLocationFromMessage(message);
        
        console.log(`날씨 정보 요청 감지 - 위치: ${location}`);
        
        try {
          const weatherData = await this.getWeather(location);
          
          if (weatherData) {
            contextInfo += this.formatWeatherInfo(weatherData) + '\n\n';
            console.log('날씨 정보 포맷팅 완료');
          }
        } catch (weatherError) {
          console.error('날씨 API 호출 중 오류:', weatherError);
          contextInfo += `날씨 정보를 제공할 수 없습니다. OpenWeatherMap API 키가 아직 활성화되지 않았거나 유효하지 않습니다.\n\n현재 서비스 상태를 확인 중입니다. 나중에 다시 시도해주세요.\n\n`;
          
          // 개발자용 로그
          console.log('날씨 API 키 확인 필요:', this.apiKey);
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
}

// 싱글톤 인스턴스 내보내기 (기본 구성으로 사용할 경우)
export const weatherDateTool = new WeatherDateTool();

// 기존 코드와의 호환성을 위한 함수들
export function getCurrentDateTime(): { 
  date: string; 
  time: string; 
  dayOfWeek: string;
  fullDateTime: string;
} {
  return weatherDateTool.getCurrentDateTime();
}

export async function getWeather(location: string = '서울'): Promise<any> {
  return weatherDateTool.getWeather(location);
}

export function formatWeatherInfo(weatherData: any): string {
  return weatherDateTool.formatWeatherInfo(weatherData);
}

export async function processWeatherAndDateRequests(message: string): Promise<{
  isProcessed: boolean;
  contextInfo?: string;
}> {
  return weatherDateTool.processWeatherAndDateRequests(message);
}
