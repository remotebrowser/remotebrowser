#!/usr/bin/env node

const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { Client } = require("@modelcontextprotocol/sdk/client");
const fs = require("fs");
const qs = require("qs");

const run = async (toolName, xSigninId = null, arguments = {}) => {
  const startTime = Date.now();
  const client = new Client({ name: "testscript", version: "1.0.0" }, { capabilities: {} });
  const urlMcp = "http://localhost:23456/mcp";
  // const urlMcp = "http://100.92.72.79/mcp";
  // const urlMcp = "http://[fdaa:40:80eb:0:1::2028]/mcp";
  // const urlMcp = "http://remotebrowser.flycast/mcp";
  // const urlMcp = "https://remotebrowser-dev.fly.dev/mcp";
  // const urlMcp = "http://remotebrowser-daytona.flycast/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(urlMcp), {
    requestInit: {
      headers: {
        "x-incognito": "1",
        "x-origin-ip": "45.131.194.160",
        // "x-origin-ip": "158.140.191.65",
        ...(xSigninId ? { "x-signin-id": xSigninId } : {}),
        // "x-signin-id": "Emqb5pab--Emqb5pab@FEAAAD04795F4BB826409ABB529CE828--d9531742c4bc4ac0b389d08027a959a5"
        //   "Emffydne--Emffydne@27219FBBE3B1EFEC9AF84D6211C16FB6--e7e3e913fd714532baeefcaca6f3e185",
      },
    },
  });
  await client.connect(transport);

  const mcpCallResult = await client.callTool(
    {
      name: toolName,
      arguments,
    },
    undefined,
    {
      timeout: 120_000,
    },
  );

  if(!mcpCallResult?.structuredContent?.url){
    
  }

  // console.log("----", mcpCallResult.structuredContent.url);
  // Write the result to a file
  // fs.writeFileSync(
  //   `mcp_call_result_${toolName}_${JSON.stringify(arguments).slice(0, 50)}.json`,
  //   JSON.stringify(mcpCallResult, null, 2),
  // );
  // console.log(mcpCallResult);

  // const endTime = Date.now();
  // const duration = endTime - startTime;
  // console.log(`Duration: ${duration}ms`);

  // return

  const signinUrl = mcpCallResult.structuredContent.url
  const signinResult = await fetch(signinUrl, {
    method: "POST",
  })
  const signinData = await signinResult.text()

  // const axios = require("axios");

  // var data = qs.stringify({
  //   email: "test@getgather.com",
  //   password: "test123",
  // });
  // var config = {
  //   method: "post",
  //   url: signinUrl,
  //   headers: {
  //     "Content-Type": "application/x-www-form-urlencoded",
  //   },
  //   data: data,
  // };

  // await axios(config)
  //   .then((res) => {
  //     // console.log(res.data);
  //   })
  //   .catch((err) => {
  //     // console.error(err);
  //   });


  const mcpFinalizeSigninCall = await client.callTool(
    {
      name: "finalize_signin",
      arguments: {
        signin_id: mcpCallResult.structuredContent.signin_id,
      },
    },
    undefined,
    {
      timeout: 120_000,
    },
  );

  const endTime = Date.now();
  const duration = endTime - startTime;
  // console.log(`Duration: ${duration}ms`);

  if (signinData.includes("Amazon Sign In")) {
    console.log(`Success | ${duration}ms`);
  } else {
    console.log(`Failed | ${duration}ms`);
  }



};

// const a = async () => {
//   for (let i = 0; i < 3; i++) {
//     await run("goodreads_get_book_list");
//     // run("amazon_get_watchlist_with_pagination");

//     // await run("walmart_get_order_history");
//     // await new Promise(resolve => setTimeout(resolve, 50_000));
//   }
// };

// a();

const intz = async () => {
  for (let i = 0; i < 30; i++) {
    run(
      "amazon_get_watchlist_with_pagination"
    );
    // run(
    //   "goodreads_get_book_list",
    //   "Ep785qsc--Ep785qsc@E2EABB28C219E44C6741CBF87E5B34B9--d33cc191747c4091b50d2586a5e31f9e",
    // );
    // run(
    //   "goodreads_get_book_list",
    //   "Ebmh4795--Ebmh4795@03E190F815225A47E5D7A19DEF75C0B9--665687327d7747fc973c280cd08644b7",
    // );
    // run(
    //   "goodreads_get_book_list",
    //   "E278umdp--E278umdp@18A7E7560633AD723400EC470367A30B--44c3fb303e90453a8b900f36b510a3b1",
    // );

    await new Promise((resolve) => setTimeout(resolve, 40_000));
  }
};

// intz();

run(
  "amazon_get_watchlist_with_pagination"
);

// run("safeway_get_purchases_in_store", "Etiw3gjy--Etiw3gjy@25ABBA4476921D0D38C5FFEE74831DCA--9976154f03f045d0823b48670ea59f7b");
//
// const signin = async () => {
//   const client = new Client({ name: "testscript", version: "1.0.0" }, { capabilities: {} });
//   const transport = new StreamableHTTPClientTransport(new URL("http://localhost:23456/mcp"), {
//     requestInit: {
//       headers: {
//         "x-incognito": "1",
//       },
//     },
//   });
// };

// run("amazon_get_watchlist_with_pagination");
// run("goodreads_get_book_list")

// run(
//   "amazon_get_watchlist_with_pagination",
//   "Er8kyybu--Er8kyybu@E643689E34F7DD4C41F0A9EBC75EDD8C--06d8e7018ef742158226dbc982def0bc",
// );
// run("amazon_get_watch_history", "Exaex7ik--Exaex7ik@F6C2F5AF5569274C599FB1D14E7EDD98--5e7b31c4fd6146f681bdef976192132e")
// run("amazon_get_watchlist", "Eysnby2j--Eysnby2j@1E5F5AE9B61976C2A09A83EBD20E81C9--231986a038b74c6ea80c3ad481c61e72")
// run("amazon_get_prime_library", "Eysnby2j--Eysnby2j@1E5F5AE9B61976C2A09A83EBD20E81C9--231986a038b74c6ea80c3ad481c61e72")

// run("safeway_get_purchases_in_store");
// run("safeway_get_purchases_online", "Eihascsn--Eihascsn@106EE65E12D0029A85A6F3DFC7469994--9f9cc374564f4001ba0df69abc6bccaf");

// run("amazon_get_purchase_history_with_details")
// run("doordash_get_orders_with_pagination")
// run("costco_get_orders");
// run("walmart_get_order_history");
// run("walmart_get_order_history", "Ee7i736d--Ee7i736d@598F3382A48457BDBC301D7724CF3A49--c73a3c023e48497797b5c6d8729fda16");

// 1 - Bot Detect - After choose radio
// 2 - No Bot - Timeout - Stuck on Dashboard
// 3 - No Bot - Success
// 4 - No Bot - Timeout no pattern found (text me or call me)
// 5 - No Bot - Pattern stay at signin - Timeout Passkey pattern (https://codeshare.io/arMY87)
// 6 - No Bot - Pattern stay at signin - Timeout - Infinite loading
