# How to Get a Fixed Extension ID

## Method 1: Pack the extension once to generate a key

1. Go to `chrome://extensions/`
2. Click "Pack extension"
3. Select the extension directory
4. Chrome generates a `.pem` file (private key)
5. Copy the `key` field from the generated `.crx` or use the .pem

## Method 2: Generate manually

Run this command to generate a key:
```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Then add to manifest.json:
```json
{
  "key": "YOUR_BASE64_PUBLIC_KEY_HERE"
}
```

## Getting your desired ID

To get the specific ID `ecjpbchjniblfcchhkhiiajhiekgblhb`, you need the original private key that generated it. 

If you don't have it, you can:
1. Generate a new key (new ID)
2. Or use that ID if you have the original extension's .pem file

