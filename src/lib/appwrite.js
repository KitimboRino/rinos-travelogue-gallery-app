import { Client, Storage } from 'appwrite';

const client = new Client()
  .setEndpoint(process.env.REACT_APP_APPWRITE_ENDPOINT)
  .setProject(process.env.REACT_APP_APPWRITE_PROJECT_ID);

export const storage = new Storage(client);
export const BUCKET_ID = process.env.REACT_APP_APPWRITE_BUCKET_ID;
export { client };
