# TypeScript typings for Some Name v1

undefined
For detailed description please check [documentation](bla).

## Installing

Install typings for Some Name:

```
npm install @types/gapi.client.some-name-v1 --save-dev
```

## Usage

You need to initialize Google API client in your code:

```typescript
gapi.load('client', () => {
  // now we can use gapi.client
  // ...
});
```

Then load api client wrapper:

```typescript
gapi.client.load('http://x.com/', () => {
  // now we can use:
  // gapi.client.thirdNamespace
});
```

```typescript
// Deprecated, use discovery document URL, see https://github.com/google/google-api-javascript-client/blob/master/docs/reference.md#----gapiclientloadname----version----callback--
gapi.client.load('some-name', 'v1', () => {
  // now we can use:
  // gapi.client.thirdNamespace
});
```



After that you can use Some Name resources: <!-- TODO: make this work for multiple namespaces -->

```typescript

/*
undefined
*/
await gapi.client.thirdNamespace.firstMethod({  });
```