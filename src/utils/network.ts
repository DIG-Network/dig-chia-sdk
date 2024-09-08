import superagent from 'superagent';

const MAX_RETRIES = 5;
const RETRY_DELAY = 2000; // in milliseconds

export const getPublicIpAddress = async (): Promise<string | undefined> => {
  const publicIp = process.env.PUBLIC_IP;

  if (publicIp) {
    console.log('Public IP address from env:', publicIp);
    return publicIp;
  }

  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const response = await superagent.get('https://api.datalayer.storage/user/v1/get_user_ip');
      if (response.body && response.body.success) {
        console.log('Public IP address:', response.body);
        return response.body.ip_address;
      } else {
        throw new Error('Failed to retrieve public IP address');
      }
    } catch (error: any) {
      attempt++;
      console.error(`Error fetching public IP address (Attempt ${attempt}):`, error.message);

      if (attempt >= MAX_RETRIES) {
        throw new Error('Could not retrieve public IP address after several attempts');
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
};
