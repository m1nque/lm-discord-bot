import axios from 'axios';
import moment from 'moment';
// @ts-ignore
import 'moment/locale/ko'; // 한국어 로케일 설정
import dotenv from 'dotenv';

// 환경 변수가 확실히 로드되도록 dotenv 설정
dotenv.config();

// 현재 날짜 및 시간 정보를 가져오는 함수
export function getCurrentDateTime(): { 
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

// OpenWeatherMap API를 사용하여 날씨 정보 가져오기
export async function getWeather(location: string = '서울'): Promise<any> {
  try {
    const API_KEY = process.env.OPENWEATHER_API_KEY;
    
    if (!API_KEY) {
      console.error('OpenWeatherMap API 키가 설정되지 않았습니다.');
      throw new Error('OpenWeatherMap API 키가 설정되지 않았습니다. .env 파일에 OPENWEATHER_API_KEY를 추가해주세요.');
    }
    
    console.log(`날씨 정보 요청 - 위치: ${location}, API 키 존재: ${API_KEY ? '예' : '아니오'}`);
    
    // 위치 정보 검색 (좌표 획득)
    try {
      const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(location)}&limit=1&appid=${API_KEY}`;
      console.log(`지오코딩 API 요청: ${geoUrl.replace(API_KEY, 'API_KEY_HIDDEN')}`);
      
      const geoResponse = await axios.get(geoUrl);
      
      if (!geoResponse.data || geoResponse.data.length === 0) {
        console.error(`위치 정보를 찾을 수 없습니다: ${location}`);
        throw new Error(`위치 정보를 찾을 수 없습니다: ${location}`);
      }
      
      const { lat, lon } = geoResponse.data[0];
      console.log(`위치 정보 획득 성공 - 위도: ${lat}, 경도: ${lon}`);
      
      // 날씨 정보 가져오기
      const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${API_KEY}&units=metric&lang=kr`;
      console.log(`날씨 API 요청: ${weatherUrl.replace(API_KEY, 'API_KEY_HIDDEN')}`);
      
      const weatherResponse = await axios.get(weatherUrl);
      
      const weatherData = weatherResponse.data;
      console.log('날씨 데이터 획득 성공');
      
      return {
        location: weatherData.name,
        description: weatherData.weather[0].description,
        temperature: weatherData.main.temp,
        feelsLike: weatherData.main.feels_like,
        humidity: weatherData.main.humidity,
        windSpeed: weatherData.wind.speed,
        sunrise: moment.unix(weatherData.sys.sunrise).format('HH:mm'),
        sunset: moment.unix(weatherData.sys.sunset).format('HH:mm')
      };
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

// 날씨 정보를 텍스트로 포맷팅
export function formatWeatherInfo(weatherData: any): string {
  return `
📍 **${weatherData.location}** 날씨 정보:
- 날짜: ${getCurrentDateTime().date}
- 날씨: ${weatherData.description}
- 현재 기온: ${weatherData.temperature}°C (체감 온도: ${weatherData.feelsLike}°C)
- 습도: ${weatherData.humidity}%
- 풍속: ${weatherData.windSpeed}m/s
- 일출: ${weatherData.sunrise}
- 일몰: ${weatherData.sunset}
  `.trim();
}
